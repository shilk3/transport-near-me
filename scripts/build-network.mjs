// Downloads each TfNSW static GTFS bundle and keeps only what the app needs:
// stop locations, route names and, for feeds whose realtime updates carry
// only delays, a compact timetable. The bundles are large (buses is hundreds
// of MB, mostly stop_times.txt), so they are streamed and anything unused is
// skipped without being stored.
//
//   TFNSW_API_KEY=... node scripts/build-network.mjs
import { Readable } from 'node:stream';
import { writeFile, mkdir, access } from 'node:fs/promises';
import unzipper from 'unzipper';
import { parse } from 'csv-parse';
import { FEEDS, tfnswFetch } from '../lib/feeds.js';
import { sydneyDate } from '../lib/time.js';

const OUT = new URL('../data/network.json', import.meta.url);
const DAYS_BACK = 1;
const DAYS_AHEAD = 28; // about as far as the bundles go; rebuild before it runs out
const round = (n) => Math.round(Number(n) * 1e6) / 1e6;
const secs = (hms) => {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

// yyyymmdd strings and weekdays for the dates the timetable should cover
function coveredDays() {
  const today = sydneyDate(Date.now() / 1000);
  const base = Date.UTC(+today.slice(0, 4), +today.slice(4, 6) - 1, +today.slice(6, 8));
  const out = [];
  for (let i = -DAYS_BACK; i <= DAYS_AHEAD; i++) {
    const d = new Date(base + i * 86400000);
    out.push({ date: d.toISOString().slice(0, 10).replace(/-/g, ''), weekday: d.getUTCDay() });
  }
  return out;
}
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

async function readBundle(feed) {
  const want = new Set(['stops.txt', 'routes.txt']);
  if (feed.timetable) for (const f of ['trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt']) want.add(f);
  const rows = {};
  const res = await tfnswFetch(feed.schedule, { timeoutMs: 600000 });
  const parsing = [];
  await new Promise((resolve, reject) => {
    Readable.fromWeb(res.body)
      .pipe(unzipper.Parse())
      .on('entry', (entry) => {
        const name = entry.path.split('/').pop();
        if (!want.has(name)) return entry.autodrain();
        const list = (rows[name] = []);
        parsing.push(new Promise((done, fail) => {
          entry.pipe(parse({ columns: true, bom: true, relax_column_count: true }))
            .on('data', (r) => list.push(r))
            .on('end', done)
            .on('error', fail);
        }));
      })
      .on('close', resolve)
      .on('error', reject);
  });
  await Promise.all(parsing);

  const stops = (rows['stops.txt'] || []).filter((r) => r.stop_lat && r.stop_lon)
    .map((r) => [r.stop_id, r.stop_name, round(r.stop_lat), round(r.stop_lon), r.parent_station || '', Number(r.location_type || 0)]);
  const routes = {};
  for (const r of rows['routes.txt'] || []) routes[r.route_id] = [r.route_short_name || '', r.route_long_name || '', r.route_color || ''];
  const out = { stops, routes };
  if (feed.timetable) out.timetable = buildTimetable(rows);
  return out;
}

// Trips running on the covered days, with identical stop/time patterns
// stored once: { patterns: [[headsign, [stopId...], [offsetSecs...]]], trips: { tripId: [pattern, startSecs] } }
function buildTimetable(rows) {
  const days = coveredDays();
  const active = new Set();
  for (const c of rows['calendar.txt'] || []) {
    if (days.some((d) => d.date >= c.start_date && d.date <= c.end_date && c[WEEKDAYS[d.weekday]] === '1')) active.add(c.service_id);
  }
  const dates = new Set(days.map((d) => d.date));
  for (const c of rows['calendar_dates.txt'] || []) {
    // Exceptions can add a service; a removal on one day doesn't stop it running on the others
    if (c.exception_type === '1' && dates.has(c.date)) active.add(c.service_id);
  }

  const headsign = new Map();
  for (const t of rows['trips.txt'] || []) if (active.has(t.service_id)) headsign.set(t.trip_id, t.trip_headsign || '');

  const calls = new Map();
  for (const st of rows['stop_times.txt'] || []) {
    if (!headsign.has(st.trip_id)) continue;
    const time = st.arrival_time || st.departure_time;
    if (!time) continue;
    if (!calls.has(st.trip_id)) calls.set(st.trip_id, []);
    calls.get(st.trip_id).push([Number(st.stop_sequence), st.stop_id, secs(time)]);
  }

  const patterns = [];
  const patternIdx = new Map();
  const trips = {};
  for (const [tripId, list] of calls) {
    list.sort((a, b) => a[0] - b[0]);
    const start = list[0][2];
    const p = [headsign.get(tripId), list.map((c) => c[1]), list.map((c) => c[2] - start)];
    const key = JSON.stringify(p);
    if (!patternIdx.has(key)) {
      patternIdx.set(key, patterns.length);
      patterns.push(p);
    }
    trips[tripId] = [patternIdx.get(key), start];
  }
  return { from: days[0].date, to: days[days.length - 1].date, patterns, trips };
}

const network = { builtAt: new Date().toISOString(), feeds: {} };
let failed = 0;
for (const feed of FEEDS) {
  const t0 = Date.now();
  try {
    const data = await readBundle(feed);
    network.feeds[feed.id] = { mode: feed.mode, ...data };
    const tt = data.timetable ? `, ${Object.keys(data.timetable.trips).length} timetabled trips in ${data.timetable.patterns.length} patterns` : '';
    console.log(`${feed.id}: ${data.stops.length} stops, ${Object.keys(data.routes).length} routes${tt} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
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
