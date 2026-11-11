import 'dotenv/config';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { middleware, messagingApi } from '@line/bot-sdk';
import { ethers } from 'ethers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------------
// ⚙️ การตั้งค่าราคาเงินบาท (THB) และตัวแปรสภาพแวดล้อม
// ------------------------------------------------------------------------
const PRICES = {
  MONTHLY: 990,   // ราคาแพ็กเกจรายเดือน (บาท)
  YEARLY: 9900    // ราคาแพ็กเกจรายปี (บาท)
};

const secret = process.env.LINE_CHANNEL_SECRET;
const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const rpcUrl = process.env.RPC_URL || 'https://rpc.hoodi.ethpandaops.io';
const contractAddress = process.env.CONTRACT_ADDRESS || '0x26dd0394A7251196D320F72b053134ABd6f2e67d';
const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY;

if (!secret || !token) {
  console.error('กรุณาตั้งค่า LINE_CHANNEL_SECRET และ LINE_CHANNEL_ACCESS_TOKEN ใน .env ครับ');
  process.exit(1);
}

// ฐานข้อมูล SQLite
const db = new DatabaseSync(process.env.DATABASE_PATH || './members.db');
db.exec('PRAGMA journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS memberships (
  line_user_id TEXT PRIMARY KEY,
  wallet_address TEXT,
  plan TEXT DEFAULT 'monthly',
  status TEXT DEFAULT 'None',
  requested_at TEXT
)`);

// ------------------------------------------------------------------------
// 📄 ABI ของ GymMembership.sol ตัวใหม่
// ------------------------------------------------------------------------
const contractAbi = [
  "function getMembership(address user) external view returns (uint256 dueDate, uint256 freezeUntil, uint256 freezeUsed, uint8 planMonths, uint8 status)",
  "function canEnterGym(address user) external view returns (bool)",
  "function registerMembershipForUser(address user, uint8 monthsPlan)",
  "function renewMembershipForUser(address user, uint8 monthsPlan)",
  "function freezeMembership(uint8 monthsToFreeze)",
  "function unfreezeMembership()"
];

const app = express();
const client = new messagingApi.MessagingApiClient({ channelAccessToken: token });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/liff', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'liff.html')));

app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// LINE Webhook
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

app.get('/api/member-info', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false });
  const member = db.prepare('SELECT wallet_address, status FROM memberships WHERE line_user_id = ?').get(userId);
  return res.json({ ok: true, data: member || null });
});

app.post('/api/bind-wallet', (req, res) => {
  const { lineUserId, walletAddress } = req.body;
  if (!lineUserId || !walletAddress || !ethers.isAddress(walletAddress)) {
    return res.status(400).json({ ok: false, message: 'Invalid data' });
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO memberships (line_user_id, wallet_address, plan, status, requested_at) 
    VALUES (?, ?, 'monthly', 'None', ?)
    ON CONFLICT(line_user_id) DO UPDATE SET 
      wallet_address = excluded.wallet_address,
      requested_at = excluded.requested_at`).run(lineUserId, walletAddress.toLowerCase(), now);

  return res.json({ ok: true });
});

// ------------------------------------------------------------------------
// 💳 Callback ระบบตัดเงินบาท (PromptPay Payment Relayer)
// ------------------------------------------------------------------------
app.post('/api/payment-callback', async (req, res) => {
  const { lineUserId, monthsPlan, actionType } = req.body; // actionType: 'register' หรือ 'renew'
  
  if (!lineUserId || !monthsPlan) {
    return res.status(400).json({ ok: false, message: 'Missing parameters' });
  }

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
    if (!adminPrivateKey) {
      throw new Error("ADMIN_PRIVATE_KEY missing in .env");
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const adminWallet = new ethers.Wallet(adminPrivateKey, provider);
    const contract = new ethers.Contract(contractAddress, contractAbi, adminWallet);

    let tx;
    if (actionType === 'renew') {
      tx = await contract.renewMembershipForUser(targetWallet, Number(monthsPlan));
    } else {
      tx = await contract.registerMembershipForUser(targetWallet, Number(monthsPlan));
    }
    
    await tx.wait();

    // แจ้งเตือนผ่าน LINE ทันทีเมื่อ On-chain บันทึกสำเร็จ
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
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// UI BUILDERS

// 1. การ์ดแสดงบัตรสมาชิก (Pass Card)
function buildPassCard({ wallet, statusText, canEnter, dueDate, freezeUntil }) {
  const isPassActive = canEnter;
  const isTerminated = statusText.includes('Terminated') || statusText.includes('ยกเลิก');

  const badgeColor = isPassActive ? '#10B981' : '#EF4444';
  const badgeBg = isPassActive ? '#064E3B' : '#7F1D1D';
  const badgeText = isPassActive ? 'ACCESS GRANTED' : 'ACCESS DENIED';

  const rows = [
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: 'สถานะ', size: 'xs', color: '#94A3B8', flex: 3 },
        { type: 'text', text: statusText, size: 'xs', color: isTerminated ? '#EF4444' : '#F8FAFC', weight: 'bold', flex: 5, align: 'end' }
      ]
    },
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: 'กระเป๋า', size: 'xs', color: '#94A3B8', flex: 3 },
        { type: 'text', text: wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : 'สร้างให้อัตโนมัติ', size: 'xs', color: '#38BDF8', weight: 'bold', flex: 5, align: 'end' }
      ]
    },
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: 'วันหมดอายุ', size: 'xs', color: '#94A3B8', flex: 3 },
        { type: 'text', text: isTerminated ? '-' : dueDate, size: 'xs', color: '#F8FAFC', weight: 'bold', flex: 5, align: 'end' }
      ]
    }
  ];

  if (!isTerminated && freezeUntil) {
    rows.push({
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: 'พักถึงวันที่', size: 'xs', color: '#F59E0B', flex: 3 },
        { type: 'text', text: freezeUntil, size: 'xs', color: '#F59E0B', weight: 'bold', flex: 5, align: 'end' }
      ]
    });
  }

  return {
    type: 'flex',
    altText: `บัตรสมาชิก FitChain Pass`,
    contents: {
      type: 'bubble',
      size: 'mega',
      styles: {
        body: { backgroundColor: '#0B0F19' },
        footer: { backgroundColor: '#0B0F19' }
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            contents: [
              { type: 'text', text: 'FITCHAIN', weight: 'bold', size: 'lg', color: '#F8FAFC', flex: 1 },
              {
                type: 'box',
                layout: 'horizontal',
                backgroundColor: badgeBg,
                cornerRadius: '12px',
                paddingStart: '8px',
                paddingEnd: '8px',
                paddingTop: '3px',
                paddingBottom: '3px',
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
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        paddingAll: '16px',
        paddingTop: '0px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#2563EB',
            height: 'sm',
            action: { type: 'message', label: 'เช็คสถานะปัจจุบัน', text: 'สถานะสมาชิก' }
          }
        ]
      }
    }
  };
}

// 2. การ์ดชำระเงิน PromptPay QR Code
function buildPromptPayCheckoutCard({ planTitle, priceText, planMonths, actionType }) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=PromptPay-FitChain-${priceText}-THB`;

  return {
    type: 'flex',
    altText: `ชำระเงิน ${planTitle}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      styles: {
        body: { backgroundColor: '#0B0F19' },
        footer: { backgroundColor: '#0B0F19' }
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        contents: [
          { type: 'text', text: 'PROMPTPAY THAI QR PAYMENT', weight: 'bold', size: 'xs', color: '#10B981' },
          { type: 'text', text: `ชำระเงิน ${planTitle}`, weight: 'bold', size: 'lg', color: '#F8FAFC', margin: 'xs' },
          { type: 'text', text: `ยอดชำระ: ${priceText} บาท (สแกนผ่านแอปธนาคารไทย)`, size: 'xs', color: '#94A3B8', margin: 'xs' },
          { type: 'separator', margin: 'md', color: '#1E293B' },
          { type: 'image', url: qrUrl, size: 'md', aspectRatio: '1:1', margin: 'md' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        paddingTop: '0px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#10B981',
            height: 'sm',
            action: {
              type: 'message',
              label: 'จำลองสแกนจ่ายเงินสำเร็จ',
              text: `ชำระเงินสำเร็จ ${planMonths} เดือน (${actionType})`
            }
          }
        ]
      }
    }
  };
}

// 3. เลือกแพ็กเกจ
function buildPlanSelectCard() {
  return {
    type: 'flex',
    altText: 'เลือกแพ็กเกจสมาชิก FitChain',
    contents: {
      type: 'bubble',
      size: 'mega',
      styles: { body: { backgroundColor: '#0B0F19' } },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        contents: [
          { type: 'text', text: 'MEMBERSHIP TIERS', weight: 'bold', size: 'xs', color: '#38BDF8' },
          { type: 'text', text: 'เลือกแพ็กเกจสมาชิก', weight: 'bold', size: 'xl', color: '#F8FAFC', margin: 'xs' },
          { type: 'text', text: 'ชำระผ่านแอปธนาคารไทย ระบบจะบันทึกสิทธิ์ลง Blockchain ให้อัตโนมัติ', size: 'xs', color: '#64748B', wrap: true, margin: 'sm' },
          { type: 'separator', margin: 'lg', color: '#1E293B' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'lg',
            backgroundColor: '#131B2E',
            cornerRadius: '12px',
            paddingAll: '14px',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                alignItems: 'center',
                contents: [
                  { type: 'text', text: 'รายเดือน (1 เดือน)', weight: 'bold', size: 'sm', color: '#F8FAFC', flex: 1 },
                  { type: 'text', text: `${PRICES.MONTHLY.toLocaleString()} บาท`, size: 'xs', color: '#10B981', weight: 'bold' }
                ]
              },
              {
                type: 'button',
                style: 'primary',
                color: '#2563EB',
                height: 'sm',
                margin: 'md',
                action: { type: 'message', label: 'จ่ายเงินบาท (รายเดือน)', text: 'สมัครแพ็กเกจรายเดือน' }
              }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            backgroundColor: '#1E1B4B',
            cornerRadius: '12px',
            paddingAll: '14px',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                alignItems: 'center',
                contents: [
                  { type: 'text', text: 'รายปี (12 เดือน)', weight: 'bold', size: 'sm', color: '#F8FAFC', flex: 1 },
                  { type: 'text', text: `${PRICES.YEARLY.toLocaleString()} บาท`, size: 'xs', color: '#A855F7', weight: 'bold' }
                ]
              },
              {
                type: 'button',
                style: 'primary',
                color: '#7C3AED',
                height: 'sm',
                margin: 'md',
                action: { type: 'message', label: 'จ่ายเงินบาท (รายปี)', text: 'สมัครแพ็กเกจรายปี' }
              }
            ]
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

    if (rawText === 'สมัครสมาชิก') {
      reply = buildPlanSelectCard();
    }
    else if (rawText === 'สมัครแพ็กเกจรายเดือน') {
      reply = buildPromptPayCheckoutCard({
        planTitle: 'แพ็กเกจรายเดือน (30 วัน)',
        priceText: PRICES.MONTHLY.toLocaleString(),
        planMonths: 1,
        actionType: 'register'
      });
    }
    else if (rawText === 'สมัครแพ็กเกจรายปี') {
      reply = buildPromptPayCheckoutCard({
        planTitle: 'แพ็กเกจรายปี (365 วัน)',
        priceText: PRICES.YEARLY.toLocaleString(),
        planMonths: 12,
        actionType: 'register'
      });
    }
    else if (rawText === 'ต่ออายุสมาชิก') {
      reply = buildPromptPayCheckoutCard({
        planTitle: 'ต่ออายุสมาชิก (+1 เดือน)',
        priceText: PRICES.MONTHLY.toLocaleString(),
        planMonths: 1,
        actionType: 'renew'
      });
    }
    // จำลองเมื่อผู้ใช้กดสแกนชำระเงินสำเร็จ
    else if (rawText.startsWith('ชำระเงินสำเร็จ')) {
      const months = rawText.includes('12') ? 12 : 1;
      const isRenew = rawText.includes('renew');
      
      fetch(`http://localhost:${process.env.PORT || 3000}/api/payment-callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          lineUserId: userId, 
          monthsPlan: months,
          actionType: isRenew ? 'renew' : 'register'
        })
      }).catch(err => console.error("Self call error:", err));

      reply = {
        type: 'text',
        text: '⏳ ได้รับยอดชำระเงินบาทแล้ว! ระบบกำลังบันทึกสิทธิ์ของคุณลงบล็อกเชน (Gasless Transfer)...'
      };
    }
    else if (rawText.replace(/\s+/g, '') === 'สถานะสมาชิก') {
      const member = db.prepare('SELECT wallet_address FROM memberships WHERE line_user_id = ?').get(userId);
      if (!member?.wallet_address) {
        reply = buildPassCard({
          wallet: null,
          statusText: 'ยังไม่ลงทะเบียน',
          canEnter: false,
          dueDate: '-',
          freezeUntil: null
        });
      } else {
        try {
          const fetchReq = new ethers.FetchRequest(rpcUrl);
          fetchReq.timeout = 7000;
          const provider = new ethers.JsonRpcProvider(fetchReq, undefined, { staticNetwork: true });
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
          reply = {
            type: 'text',
            text: `ดึงข้อมูลบล็อกเชนไม่สำเร็จ: ${err.shortMessage || err.message}`
          };
        }
      }
    }
  }

  if (reply) {
    await client.replyMessage({ replyToken: event.replyToken, messages: [reply] });
  }
}

app.listen(Number(process.env.PORT) || 3000, () => console.log('FitChain Premium Bot with PromptPay Relayer is ready on port 3000'));
