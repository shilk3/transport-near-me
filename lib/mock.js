// A small made-up network around Central so the UI can be tried without an
// API key. Vehicles move along their lines in real time.
import { Network } from './network.js';

const LINES = [
  { feed: 'sydneytrains', mode: 'train', route: 'T1', name: 'North Shore & Western', from: [-33.92, 151.15], to: [-33.80, 151.25], n: 9, every: 6, speed: 900 },
  { feed: 'metro', mode: 'metro', route: 'M1', name: 'Metro North West & Bankstown', from: [-33.86, 151.23], to: [-33.91, 151.17], n: 7, every: 4, speed: 1100 },
  { feed: 'lr-cbdse', mode: 'lightrail', route: 'L2', name: 'Randwick Line', from: [-33.861, 151.211], to: [-33.915, 151.24], n: 10, every: 8, speed: 360 },
  { feed: 'buses', mode: 'bus', route: '333', name: 'Circular Quay to North Bondi', from: [-33.87, 151.19], to: [-33.89, 151.27], n: 14, every: 5, speed: 420 },
  { feed: 'buses', mode: 'bus', route: '370', name: 'Leichhardt to Coogee', from: [-33.875, 151.17], to: [-33.92, 151.255], n: 14, every: 12, speed: 380 },
  { feed: 'buses', mode: 'bus', route: '431', name: 'Martin Place to Glebe Point', from: [-33.868, 151.212], to: [-33.874, 151.18], n: 10, every: 10, speed: 400 },
];

let cached = null;

function build() {
  const feeds = {};
  const lines = LINES.map((l, li) => {
    const stops = [];
    for (let i = 0; i < l.n; i++) {
      const f = i / (l.n - 1);
      const wiggle = Math.sin(f * Math.PI * 2 + li) * 0.004;
      stops.push([`${li}-${i}`, `${l.route} stop ${i + 1}`, l.from[0] + (l.to[0] - l.from[0]) * f + wiggle, l.from[1] + (l.to[1] - l.from[1]) * f - wiggle]);
    }
    stops[stops.length - 1][1] = l.name.split(' to ').pop().split(' & ')[0] + ' terminus';
    feeds[l.feed] ??= { mode: l.mode, stops: [], routes: {} };
    feeds[l.feed].stops.push(...stops.map(([id, name, lat, lon]) => [id, name, lat, lon, '', 0]));
    feeds[l.feed].routes[l.route] = [l.route, l.name, ''];
    return { ...l, stops };
  });
  return { network: new Network({ builtAt: 'mock', feeds }), lines };
}

export function network() {
  cached ??= build();
  return cached.network;
}

export function trips() {
  cached ??= build();
  const now = Date.now() / 1000;
  const out = [];
  for (const l of cached.lines) {
    const hop = 120; // seconds between stops
    const span = hop * (l.n - 1);
    const period = l.every * 60;
    for (let start = Math.floor((now - span) / period) * period; start < now + 3600; start += period) {
      const calls = l.stops.map(([id], i) => ({ stopId: id, t: Math.round(start + i * hop), delay: (i * 17) % 90 }));
      let vehicle = null;
      const p = (now - start) / hop;
      if (p >= 0 && p <= l.n - 1) {
        const i = Math.min(Math.floor(p), l.n - 2);
        const f = p - i;
        const [, , aLat, aLon] = l.stops[i];
        const [, , bLat, bLon] = l.stops[i + 1];
        const bearing = (Math.atan2((bLon - aLon) * Math.cos(aLat * Math.PI / 180), bLat - aLat) * 180 / Math.PI + 360) % 360;
        vehicle = { lat: aLat + (bLat - aLat) * f, lon: aLon + (bLon - aLon) * f, bearing, ts: Math.round(now), label: '', routeId: l.route };
      }
      out.push({ feed: l.feed, mode: l.mode, tripId: `${l.route}-${start}`, routeId: l.route, vehicleId: '', calls, vehicle });
    }
  }
  return out;
}
