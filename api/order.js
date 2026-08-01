// api/order.js — v5: 不再處理檔案上傳（檔案已由瀏覽器直接上傳到 Apps Script）
// 這支 API 只負責：計算金額、寫入 Sheet、觸發寄信（透過 Apps Script）
// 因為不含檔案處理，執行速度極快，不會逾時
import { google } from 'googleapis';
import crypto from 'crypto';
import { calcPrice } from '../lib/pricing.js';

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

async function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function sendEmailViaAppsScript(payload) {
  try {
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'sendEmail', ...payload }),
      redirect: 'follow',
    });
  } catch (err) {
    console.error('Email send error:', err);
  }
}

const recentSubmissions = new Map();
function getSubmissionHash(room, teacher, customer, pickup, itemsStr) {
  return crypto.createHash('sha256').update(`${room}|${teacher}|${customer}|${pickup}|${itemsStr}`).digest('hex');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { room, teacher, teacherEmail, customer, pickup, note, items } = req.body;

    if (!room || !teacher || !customer || !pickup || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: '缺少必要欄位' });
    }

    // ── 防止重複送出 ──
    const itemsStr = JSON.stringify(items.map(i => ({ name: i.name, type: i.type, qty: i.qty, pages: i.pages })));
    const hash = getSubmissionHash(room, teacher, customer, pickup, itemsStr);
    const now = Date.now();
    for (const [key, v] of recentSubmissions.entries()) {
      if (now - v.ts > 5 * 60 * 1000) recentSubmissions.delete(key);
    }
    if (recentSubmissions.has(hash)) {
      return res.status(200).json({ success: true, orderId: recentSubmissions.get(hash).orderId, duplicate: true });
    }

    const orderId = `ORD-${Date.now()}`;
    recentSubmissions.set(hash, { orderId, ts: now });

    // ── 計算金額 ──
    let grandTotal = 0;
    let hasReviewNeeded = false;
    const calculatedItems = items.map(item => {
      const result = calcPrice(item.type, item.pages, item.qty);
      grandTotal += result.total;
      if (result.needsReview) hasReviewNeeded = true;
      return {
        ...item, ...result,
        coverLinks: item.coverLink ? [item.coverLink] : [],
        innerLinks: item.innerLink ? [item.innerLink] : [],
      };
    });

    const timestamp = new Date().toISOString();

    // ── 寫入 Google Sheet ──
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // 欄位順序：印刷用資訊在前，價格資訊(實際張數/紙單價/單本金額/總金額)移到最後
    const rows = calculatedItems.map(item => [
      orderId, timestamp, customer, room, teacher, pickup,
      item.name, item.type, item.qty, item.pages || '',
      item.coverLinks.join(' | '), item.innerLinks.join(' | '), note,
      item.needsReview ? '⚠需確認：' + (item.reviewReason || '') : '',
      item.sheets, item.rate, item.unit, item.total,
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `訂單記錄!A:R`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    // ── 寄信（不等待完成，讓 API 快速回應）──
    const allCoverLinks = calculatedItems.flatMap(i => i.coverLinks);
    const allInnerLinks = calculatedItems.flatMap(i => i.innerLinks);
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}`;

    // ⚠️ 重要：Vercel回應送出後會凍結執行環境，背景任務不會真正完成
    // 所以這裡改成「等待寄信完成」再回應，確保信件真的送出
    await Promise.allSettled([
      sendAdminNotification({ orderId, timestamp, customer, room, teacher, pickup, note, items: calculatedItems, grandTotal, hasReviewNeeded, coverLinks: allCoverLinks, innerLinks: allInnerLinks, sheetUrl }),
      (teacherEmail && teacherEmail.includes('@'))
        ? sendTeacherConfirmation({ orderId, teacherEmail, teacher, room, customer, pickup, note, items: calculatedItems })
        : Promise.resolve(),
    ]);

    return res.status(200).json({ success: true, orderId });

  } catch (err) {
    console.error('Order error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function sendAdminNotification({ orderId, timestamp, customer, room, teacher, pickup, note, items, grandTotal, hasReviewNeeded, coverLinks, innerLinks, sheetUrl }) {
  const itemRows = items.map((it, i) => `
    <tr style="${it.needsReview ? 'background:#FEF2F2' : ''}">
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${i+1}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${it.name}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:11px">${it.type || '（未選擇）'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${it.qty}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${it.pages||'—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:${it.needsReview?'#DC2626':'#000'}">${it.needsReview ? '⚠ 需確認' : '$'+it.total.toLocaleString()}</td>
    </tr>`).join('');

  const warnBanner = hasReviewNeeded
    ? '<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#DC2626;font-weight:600">⚠️ 此訂單有項目無法自動計價，請人工確認金額（標紅色的項目）</div>'
    : '';

  const subject = hasReviewNeeded
    ? `【⚠️需確認】印刷新訂單 — ${room} ${teacher}`
    : `【印刷新訂單】${room} — ${teacher}  NT$${grandTotal.toLocaleString()}`;

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:#18181a;padding:18px 24px;border-radius:12px 12px 0 0">
      <p style="color:#fff;font-size:15px;font-weight:700;margin:0">🖨️ 印刷新訂單通知</p>
      <p style="color:rgba(255,255,255,.4);font-size:11px;margin:3px 0 0">${orderId}</p>
    </div>
    <div style="padding:20px 24px;border:1px solid #eee;border-top:none">
      ${warnBanner}
      <p><b>客戶：</b>${customer}　<b>教室：</b>${room}</p>
      <p><b>教師：</b>${teacher}　<b>取件：</b>${pickup}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
        <thead><tr style="background:#f5f5f5"><th style="padding:6px 8px;text-align:left">#</th><th style="padding:6px 8px;text-align:left">檔名</th><th style="padding:6px 8px;text-align:left">類型</th><th style="padding:6px 8px">數量</th><th style="padding:6px 8px">頁數</th><th style="padding:6px 8px">金額</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      <div style="background:#eff6ff;padding:14px;border-radius:8px;margin-top:16px;display:flex;justify-content:space-between">
        <span>訂單總額</span><b style="font-size:20px;color:#1d4ed8">${hasReviewNeeded ? '部分待確認' : 'NT$ ' + grandTotal.toLocaleString()}</b>
      </div>
      <div style="margin-top:16px">
        ${coverLinks.map((l,i)=>`<a href="${l}" style="display:inline-block;margin:4px 4px 0 0;padding:8px 14px;background:#18181a;color:#fff;text-decoration:none;border-radius:6px;font-size:12px">📂 封面檔${i+1}</a>`).join('')}
        ${innerLinks.map((l,i)=>`<a href="${l}" style="display:inline-block;margin:4px 4px 0 0;padding:8px 14px;background:#18181a;color:#fff;text-decoration:none;border-radius:6px;font-size:12px">📄 內頁檔${i+1}</a>`).join('')}
        <a href="${sheetUrl}" style="display:inline-block;margin:4px 0 0;padding:8px 14px;background:#fff;border:1px solid #ddd;color:#18181a;text-decoration:none;border-radius:6px;font-size:12px">📊 查看Sheet</a>
      </div>
      ${note ? `<p style="margin-top:12px;color:#666;font-size:12px">備註：${note}</p>` : ''}
    </div>
  </div>`;

  const plain = `【印刷新訂單】\n訂單：${orderId}\n教室：${room}\n教師：${teacher}\n客戶：${customer}\n取件：${pickup}\n總額：${hasReviewNeeded?'部分待確認':'NT$'+grandTotal.toLocaleString()}`;

  await sendEmailViaAppsScript({ emailType: 'admin', subject, htmlBody: html, plainBody: plain });
}

async function sendTeacherConfirmation({ orderId, teacherEmail, teacher, room, customer, pickup, note, items }) {
  const itemRows = items.map((it, i) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${i+1}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${it.name}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:11px">${it.type || '（未選擇）'}</td>
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

  const plain = `【下單確認】\n訂單：${orderId}\n教室：${room}\n取件：${pickup}`;

  await sendEmailViaAppsScript({ emailType: 'teacher', teacherEmail, subject: `【下單確認】您的印刷訂單已送出 — ${room}`, htmlBody: html, plainBody: plain });
}
