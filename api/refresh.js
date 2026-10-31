import { readMeta, refreshDue } from '../lib/refresh.js';

// Called daily by Vercel Cron (see vercel.json). Vercel sends the project's
// CRON_SECRET as a bearer token, so nobody else can trigger rebuilds.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorised' });
  const meta = readMeta();
  const { due, reason } = refreshDue(meta);
  if (!due) return res.status(200).json({ ...meta, due, reason });
  const hook = process.env.DEPLOY_HOOK_URL;
  if (!hook) return res.status(500).json({ ...meta, due, reason, error: 'DEPLOY_HOOK_URL is not set' });
  const r = await fetch(hook, { method: 'POST' });
  return res.status(r.ok ? 200 : 502).json({ ...meta, due, reason, triggered: r.ok, hookStatus: r.status });
}
