// The core query: stops inside the circle, and every trip that will call at
// one of them within the time window, with where the vehicle is now and the
// rest of its route to the end of the line.
const MAX_TRIPS = 300;
const GRACE_S = 30; // keep a vehicle that is at the stop right now

const pt = (s) => [s.lat, s.lon];

export function nearby({ network, trips, lat, lon, radius, windowS, now = Math.floor(Date.now() / 1000) }) {
  const stops = new Map();
  for (const s of network.within(lat, lon, radius)) {
    const d = network.displayStop(s);
    if (!stops.has(d.id)) stops.set(d.id, { id: d.id, name: d.name, lat: d.lat, lon: d.lon, mode: d.mode, arrivals: [] });
  }

  const found = [];
  for (const trip of trips) {
    let first = -1;
    const calls = [];
    trip.calls.forEach((c, i) => {
      if (!c.t || c.t < now - GRACE_S || c.t > now + windowS) return;
      const s = network.stops.get(c.stopId);
      if (!s) return;
      const d = network.displayStop(s);
      if (!stops.has(d.id)) return;
      if (calls.some((x) => x.stopId === d.id)) return; // two platforms of one station
      if (first < 0) first = i;
      calls.push({ stopId: d.id, name: d.name, t: c.t, delay: c.delay });
    });
    if (first < 0) continue;

    const coords = (list) => list.map((c) => network.stops.get(c.stopId)).filter(Boolean).map((s) => pt(network.displayStop(s)));
    const ahead = trip.calls.slice(0, first).filter((c) => !c.t || c.t >= now - GRACE_S);
    const path = coords(trip.calls.slice(first));
    // Dashed lead-in from where the vehicle is now to the first nearby stop
    const approach = [...coords(ahead), ...path.slice(0, 1)];
    if (trip.vehicle) approach.unshift([trip.vehicle.lat, trip.vehicle.lon]);
    const last = network.stops.get(trip.calls[trip.calls.length - 1].stopId);

    found.push({
      key: `${trip.feed}:${trip.tripId}`,
      feed: trip.feed,
      mode: trip.mode,
      routeId: trip.routeId,
      route: network.route(trip.feed, trip.routeId),
      destination: last ? network.displayStop(last).name : '',
      vehicle: trip.vehicle,
      calls,
      approach: approach.length > 1 ? approach : [],
      path,
    });
  }

  found.sort((a, b) => a.calls[0].t - b.calls[0].t);
  const kept = found.slice(0, MAX_TRIPS);
  for (const t of kept) for (const c of t.calls) stops.get(c.stopId).arrivals.push({ key: t.key, t: c.t });
  for (const s of stops.values()) s.arrivals.sort((a, b) => a.t - b.t);

  return { now, center: [lat, lon], radius, windowS, stops: [...stops.values()], trips: kept, truncated: found.length > kept.length };
}
