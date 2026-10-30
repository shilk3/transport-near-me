// Fetches and decodes the GTFS-Realtime trip update and vehicle position feeds,
// keeping the result for a short while so several phones (or quick refreshes)
// share one download.
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { FEEDS, tfnswFetch } from './feeds.js';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const TTL_MS = 30000;
const CONCURRENCY = 3;
const SKIPPED = 1; // StopTimeUpdate.ScheduleRelationship.SKIPPED

let cache = null; // { at, promise }

async function decode(path) {
  const res = await tfnswFetch(path);
  return FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
}

// Decoded messages are read as-is rather than converted to plain objects,
// which halves the CPU of a refresh. Unset scalars fall back to prototype
// defaults, so presence is checked with hasOwn.
const has = (o, k) => o != null && Object.hasOwn(o, k);
const num = (v) => (v == null ? 0 : typeof v === 'number' ? v : v.toNumber());

// Turns decoded feeds into the shape the nearby query works from. Exported so
// tests can feed it synthetic messages.
export function indexFeed(feed, tripMsg, vehicleMsg) {
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
  for (const t of trips) t.vehicle = byTrip.get(t.tripId) || (t.vehicleId && byVehicle.get(t.vehicleId)) || null;
  return trips;
}

async function loadAll() {
  const jobs = FEEDS.flatMap((f) => [[f, 'trips'], [f, 'vehicles']]);
  const results = new Map();
  const status = {};
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const [feed, kind] = jobs[next++];
      const t0 = Date.now();
      try {
        results.set(`${feed.id}:${kind}`, await decode(feed[kind]));
        status[`${feed.id}:${kind}`] = { ok: true, ms: Date.now() - t0 };
      } catch (e) {
        status[`${feed.id}:${kind}`] = { ok: false, error: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const trips = FEEDS.flatMap((f) => indexFeed(f, results.get(`${f.id}:trips`), results.get(`${f.id}:vehicles`)));
  return { at: Date.now(), trips, status };
}

export function getRealtime() {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const entry = { at: Date.now(), promise: loadAll() };
    entry.promise.catch(() => { if (cache === entry) cache = null; });
    cache = entry;
  }
  return cache.promise;
}
