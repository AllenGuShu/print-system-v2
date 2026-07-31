// api/order.js — v3: 傳取件日建資料夾、寄email給老師本人、後端仍算價（前端不顯示）
import { google } from 'googleapis';
import formidable from 'formidable';
import fs from 'fs';
import { calcPrice } from '../lib/pricing.js';

export const config = {
  api: { bodyParser: false },
};

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

async function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function uploadViaAppsScript(filePath, fileName, mimeType, itemName, pickup) {
  const fileBuffer = fs.readFileSync(filePath);
  const base64Data = fileBuffer.toString('base64');

  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName, mimeType, base64Data, itemName, pickup }),
    redirect: 'follow',
  });

  const data = await res.json();
  if (!data.success) throw new Error('檔案上傳失敗: ' + data.error);
  return data.url;
}

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({ multiples: false, maxFileSize: 50 * 1024 * 1024 });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { fields, files } = await parseForm(req);
    const get = (f) => Array.isArray(f) ? f[0] : f;

    const room        = get(fields.room);
    const teacher      = get(fields.teacher);
    const teacherEmail = get(fields.teacherEmail) || '';
    const customer     = get(fields.customer);
    const pickup       = get(fields.pickup);
    const note         = get(fields.note) || '';
    const itemsRaw     = get(fields.items);
    const items = JSON.parse(itemsRaw);

    const orderId = `ORD-${Date.now()}`;

    const coverFileList = files.coverFiles ? (Array.isArray(files.coverFiles) ? files.coverFiles : [files.coverFiles]) : [];
    const innerFileList = files.innerFiles ? (Array.isArray(files.innerFiles) ? files.innerFiles : [files.innerFiles]) : [];

    const coverIndexRaw = get(fields.coverIndexes);
    const innerIndexRaw = get(fields.innerIndexes);
    const coverIndexes = coverIndexRaw ? JSON.parse(coverIndexRaw) : [];
    const innerIndexes = innerIndexRaw ? JSON.parse(innerIndexRaw) : [];

    let grandTotal = 0;
    const calculatedItems = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const result = calcPrice(item.type, item.pages, item.qty);
      grandTotal += result.total;

      const itemCoverLinks = [];
      const itemInnerLinks = [];

      const coverPos = coverIndexes.indexOf(i);
      if (coverPos !== -1 && coverFileList[coverPos]) {
        const f = coverFileList[coverPos];
        const link = await uploadViaAppsScript(f.filepath, `封面_${f.originalFilename}`, f.mimetype, item.name, pickup);
        itemCoverLinks.push(link);
      }
      const innerPos = innerIndexes.indexOf(i);
      if (innerPos !== -1 && innerFileList[innerPos]) {
        const f = innerFileList[innerPos];
        const link = await uploadViaAppsScript(f.filepath, `內頁_${f.originalFilename}`, f.mimetype, item.name, pickup);
        itemInnerLinks.push(link);
      }

      calculatedItems.push({
        ...item, ...result,
        coverLinks: itemCoverLinks,
        innerLinks: itemInnerLinks,
      });
    }

    const timestamp = new Date().toISOString();

    // 寫入 Google Sheet
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const rows = calculatedItems.map(item => [
      orderId, timestamp, customer, room, teacher, pickup,
      item.name, item.type, item.qty, item.pages || '',
      item.sheets, item.rate, item.unit, item.total,
      item.coverLinks.join(' | '), item.innerLinks.join(' | '), note,
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `訂單記錄!A:Q`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    // 寄 email 給你/印刷負責人（含金額）
    const allCoverLinks = calculatedItems.flatMap(i => i.coverLinks);
    const allInnerLinks = calculatedItems.flatMap(i => i.innerLinks);

    await sendAdminNotification({
      orderId, timestamp, customer, room, teacher, pickup, note,
      items: calculatedItems, grandTotal,
      coverLinks: allCoverLinks, innerLinks: allInnerLinks,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}`,
    });

    // 寄 email 給老師本人（不含金額，只是下單確認）
    if (teacherEmail && teacherEmail.includes('@')) {
      await sendTeacherConfirmation({
        orderId, teacherEmail, teacher, room, customer, pickup, note,
        items: calculatedItems,
      });
    }

    return res.status(200).json({ success: true, orderId });

  } catch (err) {
    console.error('Order error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ── 寄給你/印刷負責人（含完整金額資訊）──
async function sendAdminNotification({ orderId, timestamp, customer, room, teacher, pickup, note, items, grandTotal, coverLinks, innerLinks, sheetUrl }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (!RESEND_API_KEY || NOTIFY_EMAILS.length === 0) return;

  const itemRows = items.map((it, i) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${i+1}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${it.name}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:11px">${it.type}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${it.qty}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${it.pages||'—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600">$${it.total.toLocaleString()}</td>
    </tr>`).join('');

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:#18181a;padding:18px 24px;border-radius:12px 12px 0 0">
      <p style="color:#fff;font-size:15px;font-weight:700;margin:0">🖨️ 印刷新訂單通知</p>
      <p style="color:rgba(255,255,255,.4);font-size:11px;margin:3px 0 0">${orderId}</p>
    </div>
    <div style="padding:20px 24px;border:1px solid #eee;border-top:none">
      <p><b>客戶：</b>${customer}　<b>教室：</b>${room}</p>
      <p><b>教師：</b>${teacher}　<b>取件：</b>${pickup}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
        <thead><tr style="background:#f5f5f5"><th style="padding:6px 8px;text-align:left">#</th><th style="padding:6px 8px;text-align:left">檔名</th><th style="padding:6px 8px;text-align:left">類型</th><th style="padding:6px 8px">數量</th><th style="padding:6px 8px">頁數</th><th style="padding:6px 8px">金額</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      <div style="background:#eff6ff;padding:14px;border-radius:8px;margin-top:16px;display:flex;justify-content:space-between">
        <span>訂單總額</span><b style="font-size:20px;color:#1d4ed8">NT$ ${grandTotal.toLocaleString()}</b>
      </div>
      <div style="margin-top:16px">
        ${coverLinks.map((l,i)=>`<a href="${l}" style="display:inline-block;margin:4px 4px 0 0;padding:8px 14px;background:#18181a;color:#fff;text-decoration:none;border-radius:6px;font-size:12px">📂 封面檔${i+1}</a>`).join('')}
        ${innerLinks.map((l,i)=>`<a href="${l}" style="display:inline-block;margin:4px 4px 0 0;padding:8px 14px;background:#18181a;color:#fff;text-decoration:none;border-radius:6px;font-size:12px">📄 內頁檔${i+1}</a>`).join('')}
        <a href="${sheetUrl}" style="display:inline-block;margin:4px 0 0;padding:8px 14px;background:#fff;border:1px solid #ddd;color:#18181a;text-decoration:none;border-radius:6px;font-size:12px">📊 查看Sheet</a>
      </div>
      ${note ? `<p style="margin-top:12px;color:#666;font-size:12px">備註：${note}</p>` : ''}
    </div>
  </div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'onboarding@resend.dev',
      to: NOTIFY_EMAILS,
      subject: `【印刷新訂單】${room} — ${teacher}  NT$${grandTotal.toLocaleString()}`,
      html,
    }),
  });
}

// ── 寄給老師本人（不含金額，純確認下單內容）──
async function sendTeacherConfirmation({ orderId, teacherEmail, teacher, room, customer, pickup, note, items }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;

  const itemRows = items.map((it, i) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${i+1}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${it.name}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:11px">${it.type}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${it.qty} 份</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${it.pages||'—'} 頁</td>
    </tr>`).join('');

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:#1D6E6B;padding:18px 24px;border-radius:12px 12px 0 0">
      <p style="color:#fff;font-size:15px;font-weight:700;margin:0">✓ 印刷訂單已送出</p>
      <p style="color:rgba(255,255,255,.7);font-size:11px;margin:3px 0 0">${orderId}</p>
    </div>
    <div style="padding:20px 24px;border:1px solid #eee;border-top:none">
      <p style="color:#333;font-size:14px;margin-bottom:14px">${teacher} 您好，您的印刷訂單已成功送出，印刷廠已收到以下項目：</p>
      <p><b>教室：</b>${room}　<b>客戶名：</b>${customer}</p>
      <p><b>取件時間：</b>${pickup}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
        <thead><tr style="background:#f5f5f5"><th style="padding:6px 8px;text-align:left">#</th><th style="padding:6px 8px;text-align:left">檔名</th><th style="padding:6px 8px;text-align:left">類型</th><th style="padding:6px 8px">數量</th><th style="padding:6px 8px">頁數</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      ${note ? `<p style="margin-top:14px;color:#666;font-size:12px">備註：${note}</p>` : ''}
      <p style="margin-top:18px;color:#999;font-size:11px">如需修改或有任何問題，請直接聯繫印刷廠</p>
    </div>
  </div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'onboarding@resend.dev',
      to: [teacherEmail],
      subject: `【下單確認】您的印刷訂單已送出 — ${room}`,
      html,
    }),
  });
}
