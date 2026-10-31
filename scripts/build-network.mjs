// Downloads each TfNSW static GTFS bundle and keeps only what the app needs:
// stop locations, route names, the road/track shape between each pair of
// neighbouring stops and, for feeds whose realtime updates carry only delays,
// a compact timetable. The bundles are large (buses is ~600 MB unpacked), so
// each is saved to a temp file and its files are streamed in the order needed.
//
//   TFNSW_API_KEY=... node scripts/build-network.mjs
import { createWriteStream } from 'node:fs';
import { writeFile, mkdir, access, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';
import { parse } from 'csv-parse';
import { FEEDS, tfnswFetch } from '../lib/feeds.js';
import { sydneyDate } from '../lib/time.js';
import { encode } from '../lib/polyline.js';
import { favKey } from '../lib/nearby.js';

const OUT = new URL('../data/network.json', import.meta.url);
const SERVICES_OUT = new URL('../public/services.json', import.meta.url);
const NOT_IN_SERVICE = new Set(['Out Of Service', 'Non Revenue']); // as in lib/nearby.js
const DAYS_BACK = 1;
const DAYS_AHEAD = 28; // about as far as the bundles go; rebuild before it runs out
const SIMPLIFY_M = 4; // shape points closer than this to a straight line are dropped
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

async function eachRow(dir, name, fn) {
  const file = dir.files.find((f) => f.path.split('/').pop() === name);
  if (!file) return;
  const parser = file.stream().pipe(parse({ columns: true, bom: true, relax_column_count: true, relax_quotes: true }));
  for await (const row of parser) fn(row);
}

async function readBundle(feed, tmp) {
  const zipPath = join(tmp, `${feed.id}.zip`);
  const res = await tfnswFetch(feed.schedule, { timeoutMs: 600000 });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));
  const dir = await unzipper.Open.file(zipPath);

  const stops = [];
  const stopPos = new Map();
  const stopName = new Map();
  const stopParent = new Map();
  await eachRow(dir, 'stops.txt', (r) => {
    stopName.set(r.stop_id, r.stop_name);
    if (r.parent_station) stopParent.set(r.stop_id, r.parent_station);
    if (!r.stop_lat || !r.stop_lon) return;
    stops.push([r.stop_id, r.stop_name, round(r.stop_lat), round(r.stop_lon), r.parent_station || '', Number(r.location_type || 0)]);
    stopPos.set(r.stop_id, [Number(r.stop_lat), Number(r.stop_lon)]);
  });
  const routes = {};
  await eachRow(dir, 'routes.txt', (r) => { routes[r.route_id] = [r.route_short_name || '', r.route_long_name || '', r.route_color || '']; });

  // Which services run on the covered days (timetable feeds only)
  const active = new Set();
  let lastDay = ''; // last date any service in the bundle runs
  if (feed.timetable) {
    const days = coveredDays();
    const dates = new Set(days.map((d) => d.date));
    await eachRow(dir, 'calendar.txt', (c) => {
      if (c.end_date > lastDay) lastDay = c.end_date;
      if (days.some((d) => d.date >= c.start_date && d.date <= c.end_date && c[WEEKDAYS[d.weekday]] === '1')) active.add(c.service_id);
    });
    // Exceptions can add a service; a removal on one day doesn't stop it running on the others
    await eachRow(dir, 'calendar_dates.txt', (c) => {
      if (c.exception_type === '1' && c.date > lastDay) lastDay = c.date;
      if (c.exception_type === '1' && dates.has(c.date)) active.add(c.service_id);
    });
  }

  // Station name a platform rolls up to, as the app shows it
  const displayName = (id) => {
    let s = id;
    while (stopParent.has(s) && stopName.has(stopParent.get(s))) s = stopParent.get(s);
    return stopName.get(s) || '';
  };

  const shapeOf = new Map();
  const headsign = new Map();
  const tripInfo = new Map(); // trip -> [route_id, trip_headsign]
  await eachRow(dir, 'trips.txt', (t) => {
    tripInfo.set(t.trip_id, [t.route_id, t.trip_headsign || '']);
    if (t.shape_id) shapeOf.set(t.trip_id, t.shape_id);
    if (feed.timetable && active.has(t.service_id)) headsign.set(t.trip_id, t.trip_headsign || '');
  });

  // stop_times is grouped by trip, so handle one trip at a time rather than
  // holding millions of rows.
  const shapePatterns = new Map(); // shape + stops -> { shape, stops, dists }
  const tt = { patterns: [], index: new Map(), trips: {} };
  const services = new Map(); // every route + destination, for searching favourites
  let cur = null;
  let rows = [];
  const flush = () => {
    if (!rows.length) return;
    rows.sort((a, b) => a.seq - b.seq);
    const info = tripInfo.get(cur);
    const route = info && routes[info[0]];
    if (info && !NOT_IN_SERVICE.has(route?.[1])) {
      // Same naming as the live list: timetable feeds use the headsign, the
      // rest the last stop (see lib/nearby.js)
      const dest = (feed.timetable && info[1]) || displayName(rows[rows.length - 1].stop);
      const short = route?.[0] || info[0];
      const key = `${info[0]}\t${short}\t${dest}`;
      if (dest && !services.has(key)) services.set(key, [short, dest, route?.[1] || '', favKey(feed.id, info[0], short)]);
    }
    const shape = shapeOf.get(cur);
    if (shape) {
      const key = `${shape}|${rows.map((r) => r.stop).join(',')}`;
      if (!shapePatterns.has(key)) shapePatterns.set(key, { shape, stops: rows.map((r) => r.stop), dists: rows.map((r) => r.dist) });
    }
    const timed = headsign.has(cur) ? rows.filter((r) => r.time != null) : [];
    if (timed.length) {
      const start = timed[0].time;
      const p = [headsign.get(cur), timed.map((r) => r.stop), timed.map((r) => r.time - start)];
      const key = JSON.stringify(p);
      if (!tt.index.has(key)) {
        tt.index.set(key, tt.patterns.length);
        tt.patterns.push(p);
      }
      tt.trips[cur] = [tt.index.get(key), start];
    }
    rows = [];
  };
  await eachRow(dir, 'stop_times.txt', (st) => {
    if (st.trip_id !== cur) {
      flush();
      cur = st.trip_id;
    }
    const time = st.arrival_time || st.departure_time;
    rows.push({
      seq: Number(st.stop_sequence),
      stop: st.stop_id,
      time: time ? secs(time) : null,
      dist: st.shape_dist_traveled === '' || st.shape_dist_traveled == null ? NaN : Number(st.shape_dist_traveled),
    });
  });
  flush();

  // Only the shapes that some trip pattern uses
  const wanted = new Set([...shapePatterns.values()].map((p) => p.shape));
  const shapes = new Map();
  await eachRow(dir, 'shapes.txt', (r) => {
    if (!wanted.has(r.shape_id)) return;
    if (!shapes.has(r.shape_id)) shapes.set(r.shape_id, []);
    const d = r.shape_dist_traveled;
    shapes.get(r.shape_id).push([Number(r.shape_pt_sequence), Number(r.shape_pt_lat), Number(r.shape_pt_lon), d === '' || d == null ? NaN : Number(d)]);
  });
  for (const pts of shapes.values()) pts.sort((a, b) => a[0] - b[0]);

  const segments = buildSegments(shapePatterns, shapes, stopPos);
  await rm(zipPath);

  const out = { stops, routes, segments, services: [...services.values()] };
  if (feed.timetable) {
    const days = coveredDays();
    // Usable until the end of our window or the bundle, whichever is first
    const to = [days[days.length - 1].date, lastDay].filter(Boolean).sort()[0];
    out.timetable = { from: days[0].date, to, patterns: tt.patterns, trips: tt.trips };
  }
  return out;
}

// ---- shapes between neighbouring stops ------------------------------------

const M_PER_DEG = 111320;
function metres(aLat, aLon, bLat, bLon) {
  const x = (bLon - aLon) * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  return Math.hypot(bLat - aLat, x) * M_PER_DEG;
}

// Index of the shape point for each stop, moving forward along the shape.
// Uses distance travelled when both files have it, else the nearest point.
function stopIndexes(pts, stops, dists, stopPos) {
  const useDist = dists.every((d) => Number.isFinite(d)) && pts.every((p) => Number.isFinite(p[3]));
  const out = [];
  let from = 0;
  for (let i = 0; i < stops.length; i++) {
    let idx = from;
    if (useDist) {
      while (idx < pts.length - 1 && pts[idx][3] < dists[i]) idx++;
    } else {
      const pos = stopPos.get(stops[i]);
      if (!pos) { out.push(-1); continue; }
      let best = Infinity;
      for (let j = from; j < pts.length; j++) {
        const d = metres(pos[0], pos[1], pts[j][1], pts[j][2]);
        if (d < best) { best = d; idx = j; }
        // Stop once we've clearly passed it, so a route that loops back
        // doesn't match a later pass of the same street.
        if (best < 50 && d > best + 1000) break;
      }
      if (best > 300) { out.push(-1); continue; }
    }
    out.push(idx);
    from = idx;
  }
  return out;
}

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [aLat, aLon] = pts[a];
    const [bLat, bLon] = pts[b];
    const cos = Math.cos(aLat * (Math.PI / 180));
    const dx = (bLon - aLon) * cos;
    const dy = bLat - aLat;
    const len2 = dx * dx + dy * dy;
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = (pts[i][1] - aLon) * cos;
      const py = pts[i][0] - aLat;
      const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const d = Math.hypot(px - t * dx, py - t * dy) * M_PER_DEG;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// { "stopA>stopB": encoded polyline from A to B along the road or track }
function buildSegments(patterns, shapes, stopPos) {
  const segments = {};
  for (const p of patterns.values()) {
    const pts = shapes.get(p.shape);
    if (!pts || pts.length < 2) continue;
    const idx = stopIndexes(pts, p.stops, p.dists, stopPos);
    for (let i = 1; i < p.stops.length; i++) {
      const key = `${p.stops[i - 1]}>${p.stops[i]}`;
      if (key in segments || idx[i - 1] < 0 || idx[i] < idx[i - 1]) continue;
      const a = stopPos.get(p.stops[i - 1]);
      const b = stopPos.get(p.stops[i]);
      if (!a || !b) continue;
      const line = [a, ...pts.slice(idx[i - 1], idx[i] + 1).map((q) => [q[1], q[2]]), b];
      segments[key] = encode(simplify(line, SIMPLIFY_M));
    }
  }
  return segments;
}

// ---- main -----------------------------------------------------------------

const network = { builtAt: new Date().toISOString(), feeds: {} };
const catalogue = { builtAt: network.builtAt, modes: {}, services: [] };
const tmp = await mkdtemp(join(tmpdir(), 'gtfs-'));
let failed = 0;
for (const feed of FEEDS) {
  const t0 = Date.now();
  try {
    const { services, ...data } = await readBundle(feed, tmp);
    network.feeds[feed.id] = { mode: feed.mode, ...data };
    catalogue.modes[feed.id] = feed.mode;
    for (const s of services) catalogue.services.push([feed.id, ...s]);
    const tt = data.timetable ? `, ${Object.keys(data.timetable.trips).length} timetabled trips in ${data.timetable.patterns.length} patterns` : '';
    console.log(`${feed.id}: ${services.length} services, ${data.stops.length} stops, ${Object.keys(data.routes).length} routes, ${Object.keys(data.segments).length} shaped stop pairs${tt} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    console.error(`${feed.id}: ${e.message}`);
  }
}
await rm(tmp, { recursive: true, force: true });

if (!Object.keys(network.feeds).length) {
  // Keep a previously built file rather than failing a deploy outright.
  const have = await access(OUT).then(() => true, () => false);
  console.error(have ? 'No bundles downloaded; keeping existing data/network.json' : 'No bundles downloaded');
  process.exit(have ? 0 : 1);
}
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(network));
// Every service, for searching favourites; served as a static file
catalogue.services.sort((a, b) => a[1].localeCompare(b[1], 'en', { numeric: true }) || a[2].localeCompare(b[2]));
await writeFile(SERVICES_OUT, JSON.stringify(catalogue));
// Small summary for the daily refresh check, so it needn't load the network
const ends = Object.values(network.feeds).map((f) => f.timetable?.to).filter(Boolean).sort();
await writeFile(new URL('../data/meta.json', import.meta.url), JSON.stringify({ builtAt: network.builtAt, timetableExpires: ends[0] || '' }));
console.log(`Wrote data/network.json (${failed} feed(s) failed)`);
