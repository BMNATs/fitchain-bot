import 'dotenv/config';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { middleware, messagingApi } from '@line/bot-sdk';
import { ethers } from 'ethers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const secret = process.env.LINE_CHANNEL_SECRET;
const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const rpcUrl = process.env.RPC_URL || 'https://rpc.hoodi.ethpandaops.io';
const contractAddress = process.env.CONTRACT_ADDRESS || '0x26dd0394A7251196D320F72b053134ABd6f2e67d';
const liffUrl = process.env.LIFF_URL || 'https://liff.line.me/2012056528-oeG8TTkE';
const baseUrl = process.env.BASE_URL; // *** ต้องเพิ่มใน .env เช่น BASE_URL=https://xxxx.ngrok-free.app

if (!secret || !token) {
  console.error('กรุณาตั้งค่า LINE_CHANNEL_SECRET และ LINE_CHANNEL_ACCESS_TOKEN ใน .env');
  process.exit(1);
}

if (!baseUrl) {
  console.warn('คำเตือน: ไม่พบ BASE_URL ใน .env ปุ่มดีดเข้า MetaMask อาจทำงานไม่ถูกต้อง');
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

const contractAbi = [
  "function getMembership(address user) external view returns (uint256 dueDate, uint256 freezeUntil, uint256 freezeUsed, uint8 planMonths, uint8 status)",
  "function canEnterGym(address user) external view returns (bool)"
];

const app = express();
const client = new messagingApi.MessagingApiClient({ channelAccessToken: token });

// Static & LIFF
app.use(express.static(path.join(__dirname, 'public')));
app.get('/liff', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'liff.html')));

// Bypass ngrok header
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// --- [NEW] หน้าสะพานสำหรับดีดเข้า MetaMask เพื่อแก้ปัญหาเด้งไป App Store ---
app.get('/open-metamask', (req, res) => {
  const metamaskLink = `https://metamask.app.link/dapp/${liffUrl}`;
  res.send(`
    <!DOCTYPE html>
    <html lang="th">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Launching MetaMask...</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        body { background-color: #0B0F19; color: white; font-family: sans-serif; }
      </style>
    </head>
    <body class="flex items-center justify-center h-screen text-center p-6">
      <div class="max-w-sm">
        <div class="mb-6 inline-block p-4 rounded-full bg-blue-600/20 text-blue-500 animate-bounce">
          <svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <h1 class="text-xl font-bold mb-2">กำลังเชื่อมต่อกับ MetaMask...</h1>
        <p class="text-slate-400 mb-8 text-sm">ระบบกำลังพาคุณไปยังแอป MetaMask เพื่อทำธุรกรรมบน Blockchain</p>
        <a href="${metamaskLink}" class="bg-blue-600 hover:bg-blue-500 text-white px-8 py-3 rounded-full font-bold transition-all active:scale-95 inline-block shadow-lg shadow-blue-600/30">
          เปิดแอป MetaMask
        </a>
      </div>
      <script>
        // ดีดเข้าแอปอัตโนมัติทันทีที่หน้าโหลดเสร็จ
        window.location.href = "${metamaskLink}";
      </script>
    </body>
    </html>
  `);
});

// LINE Webhook (ต้องอยู่ก่อน express.json เสมอ)
app.post('/webhook', middleware({ channelSecret: secret }), async (req, res) => {
  res.status(200).end();
  for (const event of req.body.events || []) {
    try { await handleEvent(event); }
    catch (error) {
      console.error('Event error:', error?.message || error);
    }
  }
});

// LIFF API
app.use('/api', express.json());

// API ตรวจสอบข้อมูลสมาชิกสำหรับหน้า LIFF (Auto-detect)
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

// UI BUILDERS

// 1. การ์ดแสดงบัตรสมาชิก (Membership Pass)
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
        { type: 'text', text: wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : 'ยังไม่ผูก', size: 'xs', color: '#38BDF8', weight: 'bold', flex: 5, align: 'end' }
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
    altText: `บัตรสมาชิก FitChain Pass - ${isPassActive ? 'พร้อมใช้งาน' : 'ไม่พร้อมใช้งาน'}`,
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
              {
                type: 'text',
                text: 'FITCHAIN',
                weight: 'bold',
                size: 'lg',
                color: '#F8FAFC',
                flex: 1
              },
              {
                type: 'box',
                layout: 'horizontal',
                backgroundColor: badgeBg,
                cornerRadius: '12px',
                paddingStart: '8px',
                paddingEnd: '8px',
                paddingTop: '3px',
                paddingBottom: '3px',
                contents: [
                  {
                    type: 'text',
                    text: badgeText,
                    size: 'xs',
                    color: badgeColor,
                    weight: 'bold'
                  }
                ]
              }
            ]
          },
          {
            type: 'text',
            text: 'DECENTRALIZED GYM PASS',
            size: 'xs',
            color: '#64748B',
            margin: 'xs'
          },
          {
            type: 'separator',
            margin: 'md',
            color: '#1E293B'
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'lg',
            spacing: 'sm',
            contents: rows
          }
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
            style: 'secondary',
            color: '#1E293B',
            height: 'sm',
            action: {
              type: 'message',
              label: 'รีเฟรช',
              text: 'สถานะสมาชิก'
            }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#2563EB',
            height: 'sm',
            action: {
              type: 'uri',
              label: 'จัดการผ่าน MetaMask',
              uri: `${baseUrl}/open-metamask` // <--- แก้ไขให้วิ่งผ่านหน้าสะพาน
            }
          }
        ]
      }
    }
  };
}

// 2. การ์ดเลือกแพ็กเกจ (Package Selection Card)
function buildPlanSelectCard() {
  return {
    type: 'flex',
    altText: 'เลือกแพ็กเกจสมาชิก FitChain',
    contents: {
      type: 'bubble',
      size: 'mega',
      styles: {
        body: { backgroundColor: '#0B0F19' }
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        contents: [
          {
            type: 'text',
            text: 'MEMBERSHIP TIERS',
            weight: 'bold',
            size: 'xs',
            color: '#38BDF8'
          },
          {
            type: 'text',
            text: 'เลือกแพ็กเกจของคุณ',
            weight: 'bold',
            size: 'xl',
            color: '#F8FAFC',
            margin: 'xs'
          },
          {
            type: 'text',
            text: 'เข้าใช้บริการฟิตเนสไม่จำกัดรอบ บันทึกสิทธิ์ผ่าน Smart Contract',
            size: 'xs',
            color: '#64748B',
            wrap: true,
            margin: 'sm'
          },
          {
            type: 'separator',
            margin: 'lg',
            color: '#1E293B'
          },
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
                  { type: 'text', text: 'Monthly Pass', size: 'xs', color: '#38BDF8' }
                ]
              },
              {
                type: 'text',
                text: 'เหมาะสำหรับเริ่มต้นทดลองใช้งาน\nปลดล็อกสิทธิ์เข้าใช้บริการ 30 วัน',
                size: 'xs',
                color: '#94A3B8',
                wrap: true,
                margin: 'sm'
              },
              {
                type: 'button',
                style: 'primary',
                color: '#2563EB',
                height: 'sm',
                margin: 'md',
                action: {
                  type: 'message',
                  label: 'เลือกแพ็กเกจรายเดือน',
                  text: 'สมัครแพ็กเกจรายเดือน'
                }
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
                  { type: 'text', text: 'BEST VALUE', size: 'xs', color: '#A855F7', weight: 'bold' }
                ]
              },
              {
                type: 'text',
                text: 'รับสิทธิ์เข้าฟิตเนสยาวนาน 365 วัน\nสิทธิ์ในการ Freeze พักสมาชิกเพิ่มขึ้น',
                size: 'xs',
                color: '#C4B5FD',
                wrap: true,
                margin: 'sm'
              },
              {
                type: 'button',
                style: 'primary',
                color: '#7C3AED',
                height: 'sm',
                margin: 'md',
                action: {
                  type: 'message',
                  label: 'เลือกแพ็กเกจรายปี',
                  text: 'สมัครแพ็กเกจรายปี'
                }
              }
            ]
          }
        ]
      }
    }
  };
}

// 3. การ์ดยืนยันชำระเงิน On-Chain (รับสีและชื่อแพ็กเกจแบบ Dynamic)
function buildConfirmCheckoutCard({ planTitle, tierTag, themeColor, durationDesc }) {
  return {
    type: 'flex',
    altText: `ยืนยันการสมัคร ${planTitle}`,
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
              {
                type: 'text',
                text: tierTag || 'CHECKOUT CONFIRMATION',
                weight: 'bold',
                size: 'xs',
                color: themeColor,
                flex: 1
              },
              {
                type: 'text',
                text: durationDesc || 'PROTOCOL CALL',
                size: 'xs',
                color: '#64748B',
                align: 'end'
              }
            ]
          },
          {
            type: 'text',
            text: `ยืนยันคำขอ ${planTitle}`,
            weight: 'bold',
            size: 'lg',
            color: '#F8FAFC',
            margin: 'sm'
          },
          {
            type: 'text',
            text: 'ระบบเตรียมคำขอเรียบร้อยแล้ว กรุณากดเปิด FitChain Pass เพื่อ Sign ยืนยันบน Smart Contract',
            size: 'xs',
            color: '#94A3B8',
            wrap: true,
            margin: 'sm'
          },
          {
            type: 'separator',
            margin: 'lg',
            color: '#1E293B'
          },
          {
            type: 'box',
            layout: 'horizontal',
            margin: 'lg',
            contents: [
              { type: 'text', text: 'เครือข่าย', size: 'xs', color: '#64748B', flex: 1 },
              { type: 'text', text: 'Sepolia Testnet', size: 'xs', color: '#F8FAFC', weight: 'bold', align: 'end', flex: 1 }
            ]
          }
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
            color: themeColor,
            height: 'sm',
            action: {
              type: 'uri',
              label: 'เปิดใน MetaMask ทันที',
              uri: `${baseUrl}/open-metamask` // <--- แก้ไขให้วิ่งผ่านหน้าสะพาน
            }
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
      reply = buildConfirmCheckoutCard({
        planTitle: 'แพ็กเกจรายเดือน',
        tierTag: 'MONTHLY PASS',
        themeColor: '#2563EB', 
        durationDesc: '30 DAYS'
      });
    }
    else if (rawText === 'สมัครแพ็กเกจรายปี') {
      reply = buildConfirmCheckoutCard({
        planTitle: 'แพ็กเกจรายปี',
        tierTag: 'ANNUAL ELITE PASS',
        themeColor: '#7C3AED', 
        durationDesc: '365 DAYS'
      });
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
          const statusIdx = Number(data[4]);
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
    else if (rawText === 'ต่ออายุสมาชิก') {
      reply = buildConfirmCheckoutCard({
        planTitle: 'ต่ออายุสมาชิก (+1 เดือน)',
        tierTag: 'RENEWAL',
        themeColor: '#059669',
        durationDesc: '+1 MONTH'
      });
    }
    else if (rawText === 'พักสมาชิก') {
      reply = buildConfirmCheckoutCard({
        planTitle: 'พักสมาชิก (Freeze)',
        tierTag: 'FREEZE STATUS',
        themeColor: '#D97706',
        durationDesc: 'SUSPENSION'
      });
    }
    else if (rawText === 'ยกเลิกสมาชิก') {
      reply = {
        type: 'text',
        text: 'ต้องการยกเลิกสมาชิก กรุณาติดต่อเคาน์เตอร์ฟิตเนส หรือทำรายการผ่าน DApp'
      };
    }
  }

  if (reply) {
    await client.replyMessage({ replyToken: event.replyToken, messages: [reply] });
  }
}

app.listen(Number(process.env.PORT) || 3000, () => console.log('FitChain Premium Bot is ready on port 3000'));
