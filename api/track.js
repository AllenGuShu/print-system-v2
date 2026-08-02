// api/track.js — 老師用訂單編號查詢自己的訂單
import { google } from 'googleapis';

async function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { orderId } = req.query;
  if (!orderId || !orderId.trim()) {
    return res.status(400).json({ success: false, error: '請提供訂單編號' });
  }

  try {
    const auth   = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const resp   = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: '訂單記錄!A:R',
    });

    const rows = (resp.data.values || []).filter(r => r[0] && r[0] !== '訂單編號');

    // 欄位: A訂單編號 B時間 C客戶 D教室 E教師 F取件 G檔名 H類型 I數量 J頁數
    //       K封面檔 L內頁檔 M備註 N需確認 O實際張數 P紙單價 Q單本金額 R總金額
    const target = orderId.trim();
    const matched = rows.filter(r => r[0] === target);

    if (matched.length === 0) {
      return res.status(200).json({ success: true, order: null });
    }

    const first = matched[0];
    const order = {
      orderId: first[0], timestamp: first[1], customer: first[2],
      room: first[3], teacher: first[4], pickup: first[5], note: first[12],
      items: matched.map(r => ({
        name: r[6], type: r[7],
        qty: Number(r[8]) || 0, pages: Number(r[9]) || 0,
        coverLinks: r[10] ? r[10].split(' | ') : [],
        innerLinks: r[11] ? r[11].split(' | ') : [],
      })),
    };

    return res.status(200).json({ success: true, order });

  } catch (err) {
    console.error('Track error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
