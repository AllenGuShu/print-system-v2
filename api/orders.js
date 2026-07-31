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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['x-admin-token'];
  if (token !== (process.env.ADMIN_TOKEN || 'token_demo')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const auth   = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const resp   = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: '訂單記錄!A:R',
    });

    const rows = (resp.data.values || []).filter(r => r[0] && r[0] !== '訂單編號');
    const orderMap = new Map();

    rows.forEach(r => {
      const [orderId, timestamp, customer, teacher, room, pickup,
             itemName, itemType, itemQty, itemPages, sheetsN, rate, unit, total,
             coverLinks, innerLinks, note, needsReview] = r;
      if (!orderMap.has(orderId)) {
        orderMap.set(orderId, {
          orderId, timestamp, customer, room, teacher, pickup, note,
          coverLinks: coverLinks ? coverLinks.split(' | ') : [],
          innerLinks: innerLinks ? innerLinks.split(' | ') : [],
          grandTotal: 0, items: [], hasReviewNeeded: false,
        });
      }
      const order = orderMap.get(orderId);
      const t = Number(total) || 0;
      order.grandTotal += t;
      const flagged = !!(needsReview && needsReview.trim());
      if (flagged) order.hasReviewNeeded = true;
      order.items.push({
        name: itemName, type: itemType,
        qty: Number(itemQty) || 0, pages: Number(itemPages) || 0,
        unit: Number(unit) || 0, total: t,
        needsReview: flagged, reviewReason: needsReview || '',
      });
    });

    return res.status(200).json({ orders: Array.from(orderMap.values()) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message, orders: [] });
  }
}
