import 'dotenv/config';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { middleware, messagingApi } from '@line/bot-sdk';
import { ethers } from 'ethers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PRICES = {
  MONTHLY: 990,
  YEARLY: 9900
};

const secret = process.env.LINE_CHANNEL_SECRET;
const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const rpcUrl = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const contractAddress = process.env.CONTRACT_ADDRESS;
const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY;
const liffUrl = process.env.LIFF_URL || 'https://liff.line.me/2012056528-oeG8TTkE';

if (!secret || !token) {
  console.error('กรุณาตั้งค่า LINE_CHANNEL_SECRET และ LINE_CHANNEL_ACCESS_TOKEN ใน .env ครับ');
  process.exit(1);
}

const db = new DatabaseSync(process.env.DATABASE_PATH || './members.db');
db.exec('PRAGMA journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS memberships (
  line_user_id TEXT PRIMARY KEY,
  wallet_address TEXT,
  plan TEXT DEFAULT 'monthly',
  status TEXT DEFAULT 'None',
  requested_at TEXT
)`);

const contractAbi = [
  "function getMembership(address user) external view returns (uint256 dueDate, uint256 freezeUntil, uint256 freezeUsed, uint8 planMonths, uint8 status)",
  "function canEnterGym(address user) external view returns (bool)",
  "function registerMembershipForUser(address user, uint8 monthsPlan)",
  "function renewMembershipForUser(address user, uint8 monthsPlan)",
  "function freezeMembershipForUser(address user, uint8 monthsToFreeze)",
  "function unfreezeMembershipForUser(address user)",
  "function terminateMembershipForUser(address user)"
];

const app = express();
const client = new messagingApi.MessagingApiClient({ channelAccessToken: token });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/liff', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'liff.html')));

app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

app.post('/webhook', middleware({ channelSecret: secret }), async (req, res) => {
  res.status(200).end();
  for (const event of req.body.events || []) {
    try { await handleEvent(event); }
    catch (error) {
      console.error('Event error:', error?.message || error);
    }
  }
});

app.use('/api', express.json());

// ดึงข้อมูลสมาชิกแบบ Real-time สำหรับหน้า LIFF
app.get('/api/liff-dashboard', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, message: 'Missing userId' });

  const member = db.prepare('SELECT wallet_address FROM memberships WHERE line_user_id = ?').get(userId);
  if (!member?.wallet_address) {
    return res.json({ ok: true, registered: false });
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(contractAddress, contractAbi, provider);
    const data = await contract.getMembership(member.wallet_address);
    const canEnter = await contract.canEnterGym(member.wallet_address);

    return res.json({
      ok: true,
      registered: true,
      wallet: member.wallet_address,
      dueDate: Number(data[0]),
      freezeUntil: Number(data[1]),
      freezeUsed: Number(data[2]),
      planMonths: Number(data[3]),
      status: Number(data[4] ?? data.status),
      canEnter
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// จัดการสถานะสมาชิก (Freeze / Unfreeze / Terminate) ผ่าน Relayer
app.post('/api/manage-membership', async (req, res) => {
  const { lineUserId, action, months } = req.body;
  const member = db.prepare('SELECT wallet_address FROM memberships WHERE line_user_id = ?').get(lineUserId);
  if (!member?.wallet_address) return res.status(404).json({ ok: false, message: 'ยังไม่มีข้อมูลสมาชิก' });

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const adminWallet = new ethers.Wallet(adminPrivateKey, provider);
    const contract = new ethers.Contract(contractAddress, contractAbi, adminWallet);

    let tx;
    let successMsg = '';
    if (action === 'freeze') {
      tx = await contract.freezeMembershipForUser(member.wallet_address, Number(months || 1));
      successMsg = `❄️ พักสมาชิก ${months || 1} เดือนเรียบร้อยแล้ว! วันหมดอายุถูกเลื่อนออกไปตามจริงครับ`;
    } else if (action === 'unfreeze') {
      tx = await contract.unfreezeMembershipForUser(member.wallet_address);
      successMsg = `▶️ ปลดล็อกการพักสมาชิกเรียบร้อยแล้ว! คุณสามารถเข้าใช้บริการฟิตเนสได้ทันทีครับ`;
    } else if (action === 'terminate') {
      tx = await contract.terminateMembershipForUser(member.wallet_address);
      successMsg = `🚫 ยกเลิกการเป็นสมาชิกเรียบร้อยแล้ว สิทธิ์บน Smart Contract ถูกระงับทันทีครับ`;
    } else {
      return res.status(400).json({ ok: false, message: 'Invalid action' });
    }

    await tx.wait();

    await client.pushMessage({
      to: lineUserId,
      messages: [{ type: 'text', text: `${successMsg}\n(Tx Hash: ${tx.hash})` }]
    }).catch(() => {});

    return res.json({ ok: true, txHash: tx.hash });
  } catch (err) {
    console.error("Manage Error:", err);
    return res.status(500).json({ ok: false, error: err.shortMessage || err.message });
  }
});

// สมัคร / ต่ออายุ ผ่าน PromptPay Relayer
app.post('/api/payment-callback', async (req, res) => {
  const { lineUserId, monthsPlan, actionType } = req.body;
  if (!lineUserId || !monthsPlan) return res.status(400).json({ ok: false, message: 'Missing parameters' });

  const member = db.prepare('SELECT wallet_address FROM memberships WHERE line_user_id = ?').get(lineUserId);
  let targetWallet = member?.wallet_address;

  if (!targetWallet) {
    const randomWallet = ethers.Wallet.createRandom();
    targetWallet = randomWallet.address;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO memberships (line_user_id, wallet_address, plan, status, requested_at) 
      VALUES (?, ?, ?, 'None', ?)`).run(lineUserId, targetWallet.toLowerCase(), monthsPlan == 12 ? 'yearly' : 'monthly', now);
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const adminWallet = new ethers.Wallet(adminPrivateKey, provider);
    const contract = new ethers.Contract(contractAddress, contractAbi, adminWallet);

    const tx = actionType === 'renew'
      ? await contract.renewMembershipForUser(targetWallet, Number(monthsPlan))
      : await contract.registerMembershipForUser(targetWallet, Number(monthsPlan));

    await tx.wait();

    await client.pushMessage({
      to: lineUserId,
      messages: [{
        type: 'text',
        text: `🎉 ชำระเงินสำเร็จแล้ว!\nสิทธิ์สมาชิกของคุณถูกบันทึกลง Smart Contract เรียบร้อยครับ\n(Tx Hash: ${tx.hash})`
      }]
    });

    return res.json({ ok: true, txHash: tx.hash });
  } catch (err) {
    console.error("Relayer Tx Error:", err);
    return res.status(500).json({ ok: false, error: err.shortMessage || err.message });
  }
});

// --- FLEX MESSAGE UI BUILDERS ---

function buildPassCard({ wallet, statusText, canEnter, dueDate, freezeUntil }) {
  const isPassActive = canEnter;
  const isTerminated = statusText.includes('Terminated') || statusText.includes('ยกเลิก');

  const badgeColor = isPassActive ? '#10B981' : '#EF4444';
  const badgeBg = isPassActive ? '#064E3B' : '#7F1D1D';
  const badgeText = isPassActive ? 'ACCESS GRANTED' : 'ACCESS DENIED';

  const rows = [
    {
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: 'สถานะ', size: 'xs', color: '#94A3B8', flex: 3 },
        { type: 'text', text: statusText, size: 'xs', color: isTerminated ? '#EF4444' : '#F8FAFC', weight: 'bold', flex: 5, align: 'end' }
      ]
    },
    {
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: 'กระเป๋า', size: 'xs', color: '#94A3B8', flex: 3 },
        { type: 'text', text: wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : 'สร้างให้อัตโนมัติ', size: 'xs', color: '#38BDF8', weight: 'bold', flex: 5, align: 'end' }
      ]
    },
    {
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: 'วันหมดอายุ', size: 'xs', color: '#94A3B8', flex: 3 },
        { type: 'text', text: isTerminated ? '-' : dueDate, size: 'xs', color: '#F8FAFC', weight: 'bold', flex: 5, align: 'end' }
      ]
    }
  ];

  if (!isTerminated && freezeUntil) {
    rows.push({
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: 'พักถึงวันที่', size: 'xs', color: '#F59E0B', flex: 3 },
        { type: 'text', text: freezeUntil, size: 'xs', color: '#F59E0B', weight: 'bold', flex: 5, align: 'end' }
      ]
    });
  }

  return {
    type: 'flex',
    altText: 'บัตรสมาชิก FitChain Pass',
    contents: {
      type: 'bubble',
      size: 'mega',
      styles: { body: { backgroundColor: '#0B0F19' }, footer: { backgroundColor: '#0B0F19' } },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '20px',
        contents: [
          {
            type: 'box', layout: 'horizontal', alignItems: 'center',
            contents: [
              { type: 'text', text: 'FITCHAIN', weight: 'bold', size: 'lg', color: '#F8FAFC', flex: 1 },
              {
                type: 'box', layout: 'horizontal', backgroundColor: badgeBg, cornerRadius: '12px',
                paddingStart: '8px', paddingEnd: '8px', paddingTop: '3px', paddingBottom: '3px',
                contents: [{ type: 'text', text: badgeText, size: 'xs', color: badgeColor, weight: 'bold' }]
              }
            ]
          },
          { type: 'text', text: 'DECENTRALIZED GYM PASS', size: 'xs', color: '#64748B', margin: 'xs' },
          { type: 'separator', margin: 'md', color: '#1E293B' },
          { type: 'box', layout: 'vertical', margin: 'lg', spacing: 'sm', contents: rows }
        ]
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '16px', paddingTop: '0px',
        contents: [
          {
            type: 'button', style: 'primary', color: '#2563EB', height: 'sm',
            action: { type: 'uri', label: 'เปิดบัตร & QR สแกนเข้าฟิตเนส', uri: liffUrl }
          }
        ]
      }
    }
  };
}

function buildPlanSelectCard(actionType = 'register') {
  const isRenew = actionType === 'renew';
  const titleText = isRenew ? 'ต่ออายุสมาชิก' : 'เลือกแพ็กเกจสมาชิก';
  const prefixCmd = isRenew ? 'ต่ออายุแพ็กเกจ' : 'สมัครแพ็กเกจ';

  return {
    type: 'flex',
    altText: titleText,
    contents: {
      type: 'bubble',
      size: 'mega',
      styles: { body: { backgroundColor: '#0B0F19' } },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '20px',
        contents: [
          { type: 'text', text: 'MEMBERSHIP TIERS', weight: 'bold', size: 'xs', color: '#38BDF8' },
          { type: 'text', text: titleText, weight: 'bold', size: 'xl', color: '#F8FAFC', margin: 'xs' },
          { type: 'text', text: 'ชำระผ่านแอปธนาคารไทย ระบบบันทึกสิทธิ์ลง Blockchain อัตโนมัติ', size: 'xs', color: '#64748B', wrap: true, margin: 'sm' },
          { type: 'separator', margin: 'lg', color: '#1E293B' },
          {
            type: 'box', layout: 'vertical', margin: 'lg', backgroundColor: '#131B2E', cornerRadius: '12px', paddingAll: '14px',
            contents: [
              {
                type: 'box', layout: 'horizontal', alignItems: 'center',
                contents: [
                  { type: 'text', text: 'รายเดือน (30 วัน)', weight: 'bold', size: 'sm', color: '#F8FAFC', flex: 1 },
                  { type: 'text', text: `${PRICES.MONTHLY.toLocaleString()} บาท`, size: 'xs', color: '#10B981', weight: 'bold' }
                ]
              },
              {
                type: 'button', style: 'primary', color: '#2563EB', height: 'sm', margin: 'md',
                action: { type: 'message', label: 'เลือก 1 เดือน', text: `${prefixCmd}รายเดือน` }
              }
            ]
          },
          {
            type: 'box', layout: 'vertical', margin: 'md', backgroundColor: '#1E1B4B', cornerRadius: '12px', paddingAll: '14px',
            contents: [
              {
                type: 'box', layout: 'horizontal', alignItems: 'center',
                contents: [
                  { type: 'text', text: 'รายปี (365 วัน)', weight: 'bold', size: 'sm', color: '#F8FAFC', flex: 1 },
                  { type: 'text', text: `${PRICES.YEARLY.toLocaleString()} บาท`, size: 'xs', color: '#A855F7', weight: 'bold' }
                ]
              },
              {
                type: 'button', style: 'primary', color: '#7C3AED', height: 'sm', margin: 'md',
                action: { type: 'message', label: 'เลือก 12 เดือน', text: `${prefixCmd}รายปี` }
              }
            ]
          }
        ]
      }
    }
  };
}

function buildFreezeSelectCard() {
  return {
    type: 'flex',
    altText: 'เลือกจำนวนเดือนที่ต้องการพักสมาชิก',
    contents: {
      type: 'bubble',
      size: 'mega',
      styles: { body: { backgroundColor: '#0B0F19' } },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '20px',
        contents: [
          { type: 'text', text: 'FREEZE MEMBERSHIP', weight: 'bold', size: 'xs', color: '#F59E0B' },
          { type: 'text', text: 'พักสมาชิกชั่วคราว', weight: 'bold', size: 'xl', color: '#F8FAFC', margin: 'xs' },
          { type: 'text', text: 'ยืดวันหมดอายุออกไปตามจำนวนเดือนที่พัก (รวมสูงสุด 90 วันตลอดสัญญา)', size: 'xs', color: '#94A3B8', wrap: true, margin: 'sm' },
          { type: 'separator', margin: 'lg', color: '#1E293B' },
          {
            type: 'box', layout: 'vertical', margin: 'lg', spacing: 'sm',
            contents: [
              { type: 'button', style: 'secondary', color: '#1E293B', height: 'sm', action: { type: 'message', label: 'พัก 1 เดือน (30 วัน)', text: 'ยืนยันพักสมาชิก 1 เดือน' } },
              { type: 'button', style: 'secondary', color: '#1E293B', height: 'sm', action: { type: 'message', label: 'พัก 2 เดือน (60 วัน)', text: 'ยืนยันพักสมาชิก 2 เดือน' } },
              { type: 'button', style: 'secondary', color: '#1E293B', height: 'sm', action: { type: 'message', label: 'พัก 3 เดือน (90 วัน)', text: 'ยืนยันพักสมาชิก 3 เดือน' } },
              { type: 'button', style: 'primary', color: '#059669', height: 'sm', margin: 'md', action: { type: 'message', label: 'ปลดล็อกพักสมาชิก (กลับเข้าเล่น)', text: 'ยืนยันปลดพักสมาชิก' } }
            ]
          }
        ]
      }
    }
  };
}

function buildTerminateConfirmCard() {
  return {
    type: 'flex',
    altText: 'ยืนยันการยกเลิกสมาชิก',
    contents: {
      type: 'bubble',
      size: 'mega',
      styles: { body: { backgroundColor: '#0B0F19' } },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '20px',
        contents: [
          { type: 'text', text: 'CANCEL MEMBERSHIP', weight: 'bold', size: 'xs', color: '#EF4444' },
          { type: 'text', text: 'ยืนยันการยกเลิกสมาชิก?', weight: 'bold', size: 'lg', color: '#F8FAFC', margin: 'xs' },
          { type: 'text', text: 'หากยืนยัน สิทธิ์การเข้าใช้บริการบน Smart Contract จะถูกระงับทันทีและไม่สามารถกู้คืนวันคงเหลือได้', size: 'xs', color: '#94A3B8', wrap: true, margin: 'sm' },
          {
            type: 'button', style: 'primary', color: '#DC2626', height: 'sm', margin: 'lg',
            action: { type: 'message', label: 'ยืนยันยกเลิกสมาชิกถาวร', text: 'ยืนยันยกเลิกสมาชิก' }
          }
        ]
      }
    }
  };
}

function buildPromptPayCheckoutCard({ planTitle, priceText, planMonths, actionType }) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=PromptPay-FitChain-${priceText}-THB`;

  return {
    type: 'flex',
    altText: `ชำระเงิน ${planTitle}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      styles: { body: { backgroundColor: '#0B0F19' }, footer: { backgroundColor: '#0B0F19' } },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '20px',
        contents: [
          { type: 'text', text: 'PROMPTPAY THAI QR PAYMENT', weight: 'bold', size: 'xs', color: '#10B981' },
          { type: 'text', text: `ชำระเงิน ${planTitle}`, weight: 'bold', size: 'lg', color: '#F8FAFC', margin: 'xs' },
          { type: 'text', text: `ยอดชำระ: ${priceText} บาท (สแกนผ่านแอปธนาคารไทย)`, size: 'xs', color: '#94A3B8', margin: 'xs' },
          { type: 'separator', margin: 'md', color: '#1E293B' },
          { type: 'image', url: qrUrl, size: 'md', aspectRatio: '1:1', margin: 'md' }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '0px',
        contents: [
          {
            type: 'button', style: 'primary', color: '#10B981', height: 'sm',
            action: { type: 'message', label: 'จำลองสแกนจ่ายเงินสำเร็จ', text: `ชำระเงินสำเร็จ ${planMonths} เดือน (${actionType})` }
          }
        ]
      }
    }
  };
}

const statusNames = ['None (ยังไม่เป็นสมาชิก)', 'Active (ใช้งานปกติ)', 'GracePeriod (ช่วงผ่อนผัน)', 'Frozen (พักสมาชิก)', 'Terminated (ยกเลิกแล้ว)'];

const showDate = ts => {
  if (!ts || Number(ts) === 0) return 'ไม่มีข้อมูล';
  return new Date(Number(ts) * 1000).toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
};

async function handleEvent(event) {
  const userId = event.source?.userId;
  if (!userId || !event.replyToken) return;
  let reply;

  if (event.type === 'message' && event.message?.type === 'text') {
    const rawText = event.message.text.trim();
    const port = process.env.PORT || 3000;

    // 1. สมัครสมาชิก / ต่ออายุ
    if (rawText === 'สมัครสมาชิก') {
      reply = buildPlanSelectCard('register');
    }
    else if (rawText === 'ต่ออายุสมาชิก') {
      reply = buildPlanSelectCard('renew');
    }
    else if (rawText === 'สมัครแพ็กเกจรายเดือน' || rawText === 'ต่ออายุแพ็กเกจรายเดือน') {
      const isRenew = rawText.startsWith('ต่ออายุ');
      reply = buildPromptPayCheckoutCard({
        planTitle: isRenew ? 'ต่ออายุรายเดือน (30 วัน)' : 'แพ็กเกจรายเดือน (30 วัน)',
        priceText: PRICES.MONTHLY.toLocaleString(),
        planMonths: 1,
        actionType: isRenew ? 'renew' : 'register'
      });
    }
    else if (rawText === 'สมัครแพ็กเกจรายปี' || rawText === 'ต่ออายุแพ็กเกจรายปี') {
      const isRenew = rawText.startsWith('ต่ออายุ');
      reply = buildPromptPayCheckoutCard({
        planTitle: isRenew ? 'ต่ออายุรายปี (365 วัน)' : 'แพ็กเกจรายปี (365 วัน)',
        priceText: PRICES.YEARLY.toLocaleString(),
        planMonths: 12,
        actionType: isRenew ? 'renew' : 'register'
      });
    }
    else if (rawText.startsWith('ชำระเงินสำเร็จ')) {
      const months = rawText.includes('12') ? 12 : 1;
      const isRenew = rawText.includes('renew');
      
      fetch(`http://localhost:${port}/api/payment-callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: userId, monthsPlan: months, actionType: isRenew ? 'renew' : 'register' })
      }).catch(err => console.error("Self call error:", err));

      reply = { type: 'text', text: '⏳ ได้รับยอดชำระเงินบาทแล้ว! ระบบกำลังบันทึกสิทธิ์ของคุณลงบล็อกเชน (Gasless Transfer)...' };
    }

    // 2. เช็คสถานะสมาชิก
    else if (rawText.replace(/\s+/g, '') === 'สถานะสมาชิก') {
      const member = db.prepare('SELECT wallet_address FROM memberships WHERE line_user_id = ?').get(userId);
      if (!member?.wallet_address) {
        reply = buildPassCard({ wallet: null, statusText: 'ยังไม่ลงทะเบียน', canEnter: false, dueDate: '-', freezeUntil: null });
      } else {
        try {
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const contract = new ethers.Contract(contractAddress, contractAbi, provider);
          const data = await contract.getMembership(member.wallet_address);
          const canEnter = await contract.canEnterGym(member.wallet_address);
          const statusIdx = Number(data[4] ?? data.status);
          const currentStatus = statusNames[statusIdx] || 'None';

          db.prepare('UPDATE memberships SET status = ? WHERE line_user_id = ?').run(currentStatus, userId);

          reply = buildPassCard({
            wallet: member.wallet_address,
            statusText: currentStatus,
            canEnter,
            dueDate: showDate(data[0]),
            freezeUntil: Number(data[1]) > 0 ? showDate(data[1]) : null
          });
        } catch (err) {
          reply = { type: 'text', text: `ดึงข้อมูลบล็อกเชนไม่สำเร็จ: ${err.shortMessage || err.message}` };
        }
      }
    }

    // 3. พักสมาชิก / ปลดพักสมาชิก
    else if (rawText === 'พักสมาชิก') {
      reply = buildFreezeSelectCard();
    }
    else if (rawText.startsWith('ยืนยันพักสมาชิก')) {
      const months = rawText.includes('3') ? 3 : rawText.includes('2') ? 2 : 1;
      fetch(`http://localhost:${port}/api/manage-membership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: userId, action: 'freeze', months })
      }).catch(err => console.error(err));
      reply = { type: 'text', text: `⏳ กำลังส่งคำสั่งพักสมาชิก ${months} เดือนลง Smart Contract...` };
    }
    else if (rawText === 'ยืนยันปลดพักสมาชิก') {
      fetch(`http://localhost:${port}/api/manage-membership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: userId, action: 'unfreeze' })
      }).catch(err => console.error(err));
      reply = { type: 'text', text: `⏳ กำลังส่งคำสั่งปลดล็อกการพักสมาชิกลง Smart Contract...` };
    }

    // 4. ยกเลิกสมาชิก
    else if (rawText === 'ยกเลิกสมาชิก') {
      reply = buildTerminateConfirmCard();
    }
    else if (rawText === 'ยืนยันยกเลิกสมาชิก') {
      fetch(`http://localhost:${port}/api/manage-membership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: userId, action: 'terminate' })
      }).catch(err => console.error(err));
      reply = { type: 'text', text: `⏳ กำลังดำเนินการยกเลิกสิทธิ์สมาชิกบน Smart Contract...` };
    }
  }

  if (reply) {
    await client.replyMessage({ replyToken: event.replyToken, messages: [reply] });
  }
}

app.listen(Number(process.env.PORT) || 3000, () => console.log('FitChain Bot Full Web2.5 Ready on port 3000'));
