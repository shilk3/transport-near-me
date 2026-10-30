// Local server that mimics Vercel: static files from public/, functions from
// api/. `MOCK=1 npm run dev` runs on generated data, no API key needed.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = new URL('../public/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/[^a-z]/g, '');
    try {
      const { default: handler } = await import(`../api/${name}.js`);
      req.query = Object.fromEntries(url.searchParams);
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (b) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); };
      return handler(req, res);
    } catch {
      res.statusCode = 404;
      return res.end('not found');
    }
  }
  const file = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.statusCode = 403; return res.end(); }
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}${process.env.MOCK === '1' ? ' (mock data)' : ''}`));
