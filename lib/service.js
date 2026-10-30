// Wires the network, realtime feeds and query together. MOCK=1 swaps in a
// generated network and moving vehicles so the app runs without an API key.
import { Network } from './network.js';
import { getRealtime } from './realtime.js';
import { nearby } from './nearby.js';

let network = null;
let mock = null;

async function sources() {
  if (process.env.MOCK === '1') {
    mock ??= await import('./mock.js');
    return { network: mock.network(), trips: mock.trips(), status: { mock: { ok: true } } };
  }
  network ??= Network.load();
  const rt = await getRealtime();
  return { network, trips: rt.trips, status: rt.status };
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
  return { ...nearby({ network, trips, lat, lon, radius, windowS }), failedFeeds: failed };
}

export async function statusReport() {
  const { network, trips, status } = await sources();
  const withTimes = trips.filter((t) => t.calls.some((c) => c.t)).length;
  const withVehicle = trips.filter((t) => t.vehicle).length;
  const callCounts = trips.map((t) => t.calls.length).sort((a, b) => a - b);
  return {
    networkBuiltAt: network.builtAt,
    stops: network.stops.size,
    trips: trips.length,
    tripsWithTimes: withTimes,
    tripsWithVehicle: withVehicle,
    medianCallsPerTrip: callCounts[Math.floor(callCounts.length / 2)] ?? 0,
    feeds: status,
  };
}
