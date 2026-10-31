// Wires the network, realtime feeds and query together. MOCK=1 swaps in a
// generated network and moving vehicles so the app runs without an API key.
import { Network } from './network.js';
import { getRealtime, vehicleFor } from './realtime.js';
import { nearby } from './nearby.js';
import { applyTimetable } from './timetable.js';
import { encode } from './polyline.js';
import { readMeta, refreshDue } from './refresh.js';

let network = null;
let mock = null;
const timetabled = new WeakMap(); // trips download -> trips with timetable filled in
let joined = null; // last trips + vehicles combination

async function sources() {
  if (process.env.MOCK === '1') {
    mock ??= await import('./mock.js');
    return { network: mock.network(), trips: mock.trips(), status: { mock: { ok: true } } };
  }
  network ??= Network.load();
  const rt = await getRealtime();
  // Fill in timetabled stops once per trips download, and attach vehicle
  // positions once per positions download.
  if (!timetabled.has(rt.trips)) {
    const now = Math.floor(rt.trips.at / 1000);
    timetabled.set(rt.trips, rt.trips.trips.map((t) => applyTimetable(t, network.timetables[t.feed], now)));
  }
  if (joined?.trips !== rt.trips || joined?.vehicles !== rt.vehicles) {
    const list = timetabled.get(rt.trips).map((t) => ({ ...t, vehicle: vehicleFor(t, rt.vehicles.byFeed[t.feed]) }));
    joined = { trips: rt.trips, vehicles: rt.vehicles, list };
  }
  return { network, trips: joined.list, status: { ...rt.trips.status, ...rt.vehicles.status } };
}

const num = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export async function nearbyQuery(params) {
  const lat = Number(params.lat);
  const lon = Number(params.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw Object.assign(new Error('lat and lon are required'), { status: 400 });
  const radius = num(params.radius, 1000, 100, 5000);
  const windowS = num(params.window, 60, 5, 180) * 60;
  const { network, trips, status } = await sources();
  const failed = Object.entries(status).filter(([, s]) => !s.ok).map(([k]) => k);
  const result = nearby({ network, trips, lat, lon, radius, windowS });
  // Lines go over the wire as encoded polylines, a fraction of the JSON size
  result.trips = result.trips.map((t) => ({ ...t, path: encode(t.path), approach: encode(t.approach) }));
  return { ...result, failedFeeds: failed };
}

export async function statusReport() {
  const { network, trips, status } = await sources();
  const withTimes = trips.filter((t) => t.calls.some((c) => c.t)).length;
  const withVehicle = trips.filter((t) => t.vehicle).length;
  const callCounts = trips.map((t) => t.calls.length).sort((a, b) => a - b);
  // Share of realtime stop IDs found in the static network, per feed: a low
  // number means a realtime feed and its timetable bundle don't line up.
  const match = {};
  for (const t of trips) {
    const m = (match[t.feed] ??= { trips: 0, calls: 0, known: 0, timed: 0 });
    m.trips++;
    for (const c of t.calls) {
      m.calls++;
      if (network.stops.has(c.stopId)) m.known++;
      if (c.t) m.timed++;
    }
  }
  for (const m of Object.values(match)) {
    m.known = m.calls ? `${Math.round((100 * m.known) / m.calls)}%` : '-';
    m.timed = m.calls ? `${Math.round((100 * m.timed) / m.calls)}%` : '-';
  }
  const meta = readMeta();
  return {
    networkBuiltAt: network.builtAt,
    timetableExpires: meta.timetableExpires,
    selfRefresh: { ...refreshDue(meta), deployHookSet: !!process.env.DEPLOY_HOOK_URL, cronSecretSet: !!process.env.CRON_SECRET },
    stops: network.stops.size,
    trips: trips.length,
    tripsWithTimes: withTimes,
    tripsWithVehicle: withVehicle,
    medianCallsPerTrip: callCounts[Math.floor(callCounts.length / 2)] ?? 0,
    stopMatch: match,
    feeds: status,
  };
}
