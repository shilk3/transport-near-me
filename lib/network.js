// Static network: every stop and route from the GTFS bundles, with a coarse
// grid so radius lookups don't scan every stop in NSW.
import { readFileSync } from 'node:fs';

const CELL = 0.01; // ~1.1 km north-south, ~0.9 km east-west in Sydney
const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

export function distanceM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

export class Network {
  constructor(raw) {
    this.builtAt = raw.builtAt;
    this.stops = new Map();
    this.routes = {};
    this.timetables = {};
    this.grid = new Map();
    for (const [feedId, feed] of Object.entries(raw.feeds)) {
      this.routes[feedId] = feed.routes;
      if (feed.timetable) this.timetables[feedId] = feed.timetable;
      for (const [id, name, lat, lon, parent, type] of feed.stops) {
        if (this.stops.has(id)) continue;
        const stop = { id, name, lat, lon, parent, type, feed: feedId, mode: feed.mode };
        this.stops.set(id, stop);
        const key = cellKey(lat, lon);
        if (!this.grid.has(key)) this.grid.set(key, []);
        this.grid.get(key).push(stop);
      }
    }
  }

  static load(path = new URL('../data/network.json', import.meta.url)) {
    return new Network(JSON.parse(readFileSync(path, 'utf8')));
  }

  route(feedId, routeId) {
    const r = this.routes[feedId]?.[routeId];
    return r ? { short: r[0], long: r[1], color: r[2] ? `#${r[2]}` : '' } : { short: '', long: '', color: '' };
  }

  // Platforms and entrances roll up to their station so a station shows once.
  displayStop(stop) {
    let s = stop;
    while (s.parent && this.stops.has(s.parent)) s = this.stops.get(s.parent);
    return s;
  }

  // All stops (platforms included) within radius metres.
  within(lat, lon, radius) {
    const dLat = radius / 111320;
    const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
    const out = [];
    for (let i = Math.floor((lat - dLat) / CELL); i <= Math.floor((lat + dLat) / CELL); i++) {
      for (let j = Math.floor((lon - dLon) / CELL); j <= Math.floor((lon + dLon) / CELL); j++) {
        for (const s of this.grid.get(`${i}:${j}`) || []) {
          if (s.type > 1) continue; // entrances, generic nodes, boarding areas
          if (distanceM(lat, lon, s.lat, s.lon) <= radius) out.push(s);
        }
      }
    }
    return out;
  }
}
