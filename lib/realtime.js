// Fetches and decodes the GTFS-Realtime feeds, keeping each result for a
// short while so several phones (or quick refreshes) share one download.
// Vehicle positions are small and refreshed often; trip updates (arrival
// times) are large, mostly the bus feed, and refreshed less often.
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { FEEDS, tfnswFetch } from './feeds.js';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const TTL_MS = { trips: 30000, vehicles: 10000 };
const CONCURRENCY = 3; // TfNSW allows 5 requests a second
const SKIPPED = 1; // StopTimeUpdate.ScheduleRelationship.SKIPPED

async function decode(path) {
  const res = await tfnswFetch(path);
  return FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
}

// Decoded messages are read as-is rather than converted to plain objects,
// which halves the CPU of a refresh. Unset scalars fall back to prototype
// defaults, so presence is checked with hasOwn.
const has = (o, k) => o != null && Object.hasOwn(o, k);
const num = (v) => (v == null ? 0 : typeof v === 'number' ? v : v.toNumber());

// Turns decoded feeds into the shape the nearby query works from.
function indexTrips(feed, tripMsg) {
  const trips = [];
  for (const e of tripMsg?.entity || []) {
    const tu = e.tripUpdate;
    if (!tu?.trip || tu.trip.scheduleRelationship === 3) continue; // CANCELED
    const calls = [];
    for (const u of tu.stopTimeUpdate || []) {
      if (!u.stopId) continue;
      const ev = has(u.arrival, 'time') ? u.arrival : has(u.departure, 'time') ? u.departure : u.arrival || u.departure;
      calls.push({ stopId: u.stopId, t: num(ev?.time), delay: has(ev, 'delay') ? ev.delay : null, skip: u.scheduleRelationship === SKIPPED });
    }
    trips.push({
      feed: feed.id,
      mode: feed.mode,
      tripId: tu.trip.tripId || e.id,
      routeId: tu.trip.routeId || '',
      startDate: tu.trip.startDate || '',
      vehicleId: tu.vehicle?.id || '',
      calls,
    });
  }
  return trips;
}

function indexVehicles(vehicleMsg) {
  const byTrip = new Map();
  const byVehicle = new Map();
  for (const e of vehicleMsg?.entity || []) {
    const v = e.vehicle;
    if (!v?.position) continue;
    const pos = {
      // positions are 32-bit floats; keep ~1 m and drop the noise
      lat: Math.round(v.position.latitude * 1e5) / 1e5,
      lon: Math.round(v.position.longitude * 1e5) / 1e5,
      bearing: has(v.position, 'bearing') ? v.position.bearing : null,
      ts: num(v.timestamp),
      label: v.vehicle?.label || '',
      routeId: v.trip?.routeId || '',
    };
    if (v.trip?.tripId) byTrip.set(v.trip.tripId, pos);
    if (v.vehicle?.id) byVehicle.set(v.vehicle.id, pos);
  }
  return { byTrip, byVehicle };
}

export function vehicleFor(trip, positions) {
  return positions?.byTrip.get(trip.tripId) || (trip.vehicleId && positions?.byVehicle.get(trip.vehicleId)) || null;
}

// Both halves for one feed at once. Exported so tests can feed it synthetic messages.
export function indexFeed(feed, tripMsg, vehicleMsg) {
  const positions = indexVehicles(vehicleMsg);
  return indexTrips(feed, tripMsg).map((t) => ({ ...t, vehicle: vehicleFor(t, positions) }));
}

let slots = CONCURRENCY;
const waiting = [];
async function limited(fn) {
  if (slots === 0) await new Promise((r) => waiting.push(r));
  else slots--;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else slots++;
  }
}

// kind 'trips' -> { at, trips: [...], status }; 'vehicles' -> { at, byFeed: { feedId: positions }, status }
async function load(kind) {
  const status = {};
  const decoded = await Promise.all(FEEDS.map((feed) => limited(async () => {
    const t0 = Date.now();
    try {
      const msg = await decode(feed[kind]);
      status[`${feed.id}:${kind}`] = { ok: true, ms: Date.now() - t0 };
      return msg;
    } catch (e) {
      status[`${feed.id}:${kind}`] = { ok: false, error: e.message };
      return null;
    }
  })));
  if (kind === 'trips') return { at: Date.now(), trips: FEEDS.flatMap((f, i) => indexTrips(f, decoded[i])), status };
  return { at: Date.now(), byFeed: Object.fromEntries(FEEDS.map((f, i) => [f.id, indexVehicles(decoded[i])])), status };
}

const cache = {};
function cached(kind) {
  const c = cache[kind];
  if (!c || Date.now() - c.at > TTL_MS[kind]) {
    const entry = { at: Date.now(), promise: load(kind) };
    entry.promise.catch(() => { if (cache[kind] === entry) delete cache[kind]; });
    cache[kind] = entry;
  }
  return cache[kind].promise;
}

export async function getRealtime() {
  const [trips, vehicles] = await Promise.all([cached('trips'), cached('vehicles')]);
  return { trips, vehicles };
}
