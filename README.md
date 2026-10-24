# FitChain LINE Bot — Node.js 25 edition

เวอร์ชันนี้ใช้ SQLite ในตัว Node.js (`node:sqlite`) แทน `better-sqlite3` จึงไม่ต้องคอมไพล์ native module

## เริ่มต้นบน Mac (Node.js v25.9.0)

1. เปิดโฟลเดอร์นี้ใน VS Code
2. รัน:

```bash
node -v
npm install
cp .env.example .env
```

3. เปิดไฟล์ `.env` แล้วใส่ `LINE_CHANNEL_SECRET` และ `LINE_CHANNEL_ACCESS_TOKEN` จาก Messaging API channel ของ FitChain **บนเครื่องของตัวเองเท่านั้น** ห้ามแชร์ไฟล์นี้หรืออัปโหลดขึ้น GitHub
4. รัน `npm start` แล้วตรวจสอบ `http://localhost:3000/health`
5. สำหรับ LINE Webhook ต้อง Deploy ไปยังเซิร์ฟเวอร์ที่มี HTTPS และเก็บข้อมูล SQLite แบบถาวร (persistent storage) จากนั้นตั้ง Webhook URL เป็น `https://โดเมนของคุณ/webhook` และเปิด Use webhook

## Rich Menu

ตั้ง action เป็น **ข้อความ** โดยใช้ข้อความตรงตามนี้:

- สมัครสมาชิก
- สถานะสมาชิก
- ต่ออายุสมาชิก
- เข้าFitChain

การสมัครจะบันทึกเป็น `pending_payment` เท่านั้น ไม่มีการเปิดสมาชิกหรือรับชำระเงินอัตโนมัติในเวอร์ชันนี้ ระบบต่ออายุและการยืนยันการชำระเงินยังไม่เสร็จ

## หมายเหตุ

- ใช้ Node.js 25+ เพราะต้องใช้ `node:sqlite` ที่รองรับ `DatabaseSync`
- ห้ามนำไฟล์ `.env` และ `members.db*` ขึ้น GitHub
- SQLite ในโฟลเดอร์แอปไม่เหมาะกับโฮสต์แบบ ephemeral/serverless เช่น Vercel สำหรับข้อมูลสมาชิกจริง ควรใช้ฐานข้อมูลถาวรแยกต่างหากก่อน Deploy จริง
