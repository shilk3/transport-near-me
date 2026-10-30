// Downloads each TfNSW static GTFS bundle and keeps only what the app needs:
// stop locations and route names. The bundles are large (buses is hundreds of
// MB, mostly stop_times.txt), so they are streamed and everything else is
// skipped without being stored.
//
//   TFNSW_API_KEY=... node scripts/build-network.mjs
import { Readable } from 'node:stream';
import { writeFile, mkdir, access } from 'node:fs/promises';
import unzipper from 'unzipper';
import { parse } from 'csv-parse';
import { FEEDS, tfnswFetch } from '../lib/feeds.js';

const OUT = new URL('../data/network.json', import.meta.url);
const round = (n) => Math.round(Number(n) * 1e6) / 1e6;

async function readBundle(feed) {
  const res = await tfnswFetch(feed.schedule, { timeoutMs: 600000 });
  const stops = [];
  const routes = {};
  const parsing = [];
  await new Promise((resolve, reject) => {
    Readable.fromWeb(res.body)
      .pipe(unzipper.Parse())
      .on('entry', (entry) => {
        const name = entry.path.split('/').pop();
        if (name !== 'stops.txt' && name !== 'routes.txt') return entry.autodrain();
        parsing.push(new Promise((done, fail) => {
          entry.pipe(parse({ columns: true, bom: true, relax_column_count: true }))
            .on('data', (r) => {
              if (name === 'stops.txt') {
                if (!r.stop_lat || !r.stop_lon) return;
                stops.push([r.stop_id, r.stop_name, round(r.stop_lat), round(r.stop_lon), r.parent_station || '', Number(r.location_type || 0)]);
              } else {
                routes[r.route_id] = [r.route_short_name || '', r.route_long_name || '', r.route_color || ''];
              }
            })
            .on('end', done)
            .on('error', fail);
        }));
      })
      .on('close', resolve)
      .on('error', reject);
  });
  await Promise.all(parsing);
  return { stops, routes };
}

const network = { builtAt: new Date().toISOString(), feeds: {} };
let failed = 0;
for (const feed of FEEDS) {
  const t0 = Date.now();
  try {
    const { stops, routes } = await readBundle(feed);
    network.feeds[feed.id] = { mode: feed.mode, stops, routes };
    console.log(`${feed.id}: ${stops.length} stops, ${Object.keys(routes).length} routes (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    console.error(`${feed.id}: ${e.message}`);
  }
}

if (!Object.keys(network.feeds).length) {
  // Keep a previously built file rather than failing a deploy outright.
  const have = await access(OUT).then(() => true, () => false);
  console.error(have ? 'No bundles downloaded; keeping existing data/network.json' : 'No bundles downloaded');
  process.exit(have ? 0 : 1);
}
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(network));
console.log(`Wrote data/network.json (${failed} feed(s) failed)`);
