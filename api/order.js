// api/order.js — 處理下單：上傳檔案到 Drive、寫入 Sheet、寄 email
import { google } from 'googleapis';
import formidable from 'formidable';
import fs from 'fs';
import { calcPrice } from '../lib/pricing.js';

export const config = {
  api: { bodyParser: false },
};

async function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

async function uploadToDrive(drive, filePath, fileName, mimeType, folderId) {
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: folderId ? [folderId] : undefined,
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: 'id, webViewLink',
  });
  // 設為任何人可檢視
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return res.data.webViewLink;
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

    const room     = get(fields.room);
    const teacher  = get(fields.teacher);
    const customer = get(fields.customer);
    const pickup   = get(fields.pickup);
    const note     = get(fields.note) || '';
    const itemsRaw = get(fields.items); // JSON string of item metadata (name/type/qty/pages)
    const items = JSON.parse(itemsRaw);

    const auth  = await getAuth();
    const drive = google.drive({ version: 'v3', auth });
    const sheets = google.sheets({ version: 'v4', auth });

    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const orderId = `ORD-${Date.now()}`;

    // 上傳檔案（封面檔、內頁檔，皆為選填、可能多檔）
    const coverFileList = files.coverFiles ? (Array.isArray(files.coverFiles) ? files.coverFiles : [files.coverFiles]) : [];
    const innerFileList = files.innerFiles ? (Array.isArray(files.innerFiles) ? files.innerFiles : [files.innerFiles]) : [];

    const coverLinks = [];
    for (const f of coverFileList) {
      const link = await uploadToDrive(drive, f.filepath, `${orderId}_封面_${f.originalFilename}`, f.mimetype, folderId);
      coverLinks.push(link);
    }
    const innerLinks = [];
    for (const f of innerFileList) {
      const link = await uploadToDrive(drive, f.filepath, `${orderId}_內頁_${f.originalFilename}`, f.mimetype, folderId);
      innerLinks.push(link);
    }

    // 計算每個項目金額
    let grandTotal = 0;
    const calculatedItems = items.map(item => {
      const result = calcPrice(item.type, item.pages, item.qty);
      grandTotal += result.total;
      return { ...item, ...result };
    });

    const timestamp = new Date().toISOString();

    // 寫入 Google Sheet（每個項目一行）
    const rows = calculatedItems.map(item => [
      orderId, timestamp, customer, room, teacher, pickup,
      item.name, item.type, item.qty, item.pages || '',
      item.sheets, item.rate, item.unit, item.total,
      coverLinks.join(' | '), innerLinks.join(' | '), note,
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `訂單記錄!A:Q`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    // 寄 email 通知
    await sendNotificationEmail({
      orderId, timestamp, customer, room, teacher, pickup, note,
      items: calculatedItems, grandTotal, coverLinks, innerLinks,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}`,
    });

    return res.status(200).json({ success: true, orderId, grandTotal });

  } catch (err) {
    console.error('Order error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function sendNotificationEmail({ orderId, timestamp, customer, room, teacher, pickup, note, items, grandTotal, coverLinks, innerLinks, sheetUrl }) {
  // Vercel 上寄信最簡單的方式是用第三方 API（例如 Resend），這裡先用 fetch 呼叫 Resend
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (!RESEND_API_KEY || NOTIFY_EMAILS.length === 0) {
    console.log('Email not configured, skipping notification');
    return;
  }

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
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'onboarding@resend.dev',
      to: NOTIFY_EMAILS,
      subject: `【印刷新訂單】${room} — ${teacher}  NT$${grandTotal.toLocaleString()}`,
      html,
    }),
  });
}
