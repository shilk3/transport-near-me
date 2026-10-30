import { nearbyQuery } from '../lib/service.js';

export default async function handler(req, res) {
  try {
    const body = await nearbyQuery(req.query);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(body);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
}
