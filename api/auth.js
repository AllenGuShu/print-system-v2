export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { password } = req.body || {};
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'print2026';
  const ADMIN_TOKEN    = process.env.ADMIN_TOKEN    || 'token_demo';

  if (password === ADMIN_PASSWORD) {
    return res.status(200).json({ ok: true, token: ADMIN_TOKEN });
  }
  return res.status(401).json({ ok: false });
}
