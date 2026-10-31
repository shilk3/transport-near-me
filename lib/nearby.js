// The core query: stops inside the circle, and every trip that will call at
// one of them within the time window, with where the vehicle is now and the
// rest of its route to the end of the line.
const MAX_TRIPS = 600;
const PER_SERVICE = 8; // upcoming runs kept for each route + destination
const GRACE_S = 30; // keep a vehicle that is at the stop right now
const NOT_IN_SERVICE = new Set(['Out Of Service', 'Non Revenue']);

// The favourite a trip belongs to: its route number, both directions and
// every variant. Bus numbers repeat across NSW (Sydney's 818 isn't
// Newcastle's), so buses also carry the operator part of the route id.
export function favKey(feed, routeId, short) {
  return feed === 'buses' ? `${feed}:${short}:${String(routeId).split('_')[0]}` : `${feed}:${short}`;
}

export function nearby({ network, trips, lat, lon, radius, windowS, now = Math.floor(Date.now() / 1000) }) {
  const stops = new Map();
  for (const s of network.within(lat, lon, radius)) {
    const d = network.displayStop(s);
    if (!stops.has(d.id)) stops.set(d.id, { id: d.id, name: d.name, lat: d.lat, lon: d.lon, mode: d.mode, arrivals: [] });
  }

  const found = [];
  for (const trip of trips) {
    if (NOT_IN_SERVICE.has(network.route(trip.feed, trip.routeId).long)) continue;
    let first = -1;
    const calls = [];
    trip.calls.forEach((c, i) => {
      if (c.skip || !c.t || c.t < now - GRACE_S || c.t > now + windowS) return;
      const s = network.stops.get(c.stopId);
      if (!s) return;
      const d = network.displayStop(s);
      if (!stops.has(d.id)) return;
      if (calls.some((x) => x.stopId === d.id)) return; // two platforms of one station
      if (first < 0) first = i;
      calls.push({ stopId: d.id, name: d.name, t: c.t, delay: c.delay });
    });
    if (first < 0) continue;

    const line = (list) => network.line(trip.feed, list.filter((c) => !c.skip).map((c) => c.stopId));
    const ahead = trip.calls.slice(0, first).filter((c) => !c.t || c.t >= now - GRACE_S);
    const path = line(trip.calls.slice(first));
    // Dashed lead-in from where the vehicle is now to the first nearby stop
    const approach = line([...ahead, trip.calls[first]]);
    if (trip.vehicle) approach.unshift([trip.vehicle.lat, trip.vehicle.lon]);
    const stopping = trip.calls.filter((c) => !c.skip);
    const last = network.stops.get(stopping[stopping.length - 1].stopId);

    found.push({
      key: `${trip.feed}:${trip.tripId}`,
      feed: trip.feed,
      mode: trip.mode,
      routeId: trip.routeId,
      route: network.route(trip.feed, trip.routeId),
      destination: trip.headsign || (last ? network.displayStop(last).name : ''),
      vehicle: trip.vehicle,
      calls,
      approach: approach.length > 1 ? approach : [],
      path,
    });
  }

  found.sort((a, b) => a.calls[0].t - b.calls[0].t);
  // Group runs of the same service; later runs share the first one's line.
  const runs = new Map();
  const kept = [];
  for (const t of found) {
    if (kept.length >= MAX_TRIPS) break;
    t.group = `${t.feed}:${t.route.short || t.routeId}:${t.destination}`;
    t.fav = favKey(t.feed, t.routeId, t.route.short || t.routeId);
    const n = runs.get(t.group) || 0;
    if (n >= PER_SERVICE) continue;
    runs.set(t.group, n + 1);
    if (n > 0) t.path = [];
    kept.push(t);
  }
  for (const t of kept) for (const c of t.calls) stops.get(c.stopId).arrivals.push({ key: t.key, t: c.t });
  for (const s of stops.values()) s.arrivals.sort((a, b) => a.t - b.t);

  return { now, center: [lat, lon], radius, windowS, stops: [...stops.values()], trips: kept, truncated: kept.length >= MAX_TRIPS };
}
