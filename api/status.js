import { statusReport } from '../lib/service.js';

export default async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(await statusReport());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
