// TfNSW Open Data feeds. Each mode has a static GTFS bundle (for stop
// locations and route names) and matching GTFS-Realtime feeds. Trip and stop
// IDs line up within a mode, so keep each realtime feed paired with its own
// schedule bundle.
export const API_BASE = 'https://api.transport.nsw.gov.au';

export const MODES = {
  train: { label: 'Train', color: '#F6891F' },
  metro: { label: 'Metro', color: '#168388' },
  lightrail: { label: 'Light rail', color: '#E4022D' },
  bus: { label: 'Bus', color: '#00B5EF' },
  ferry: { label: 'Ferry', color: '#5AB031' },
  coach: { label: 'Regional train', color: '#D6812B' },
};

export const FEEDS = [
  { id: 'sydneytrains', mode: 'train', schedule: '/v2/gtfs/schedule/sydneytrains', trips: '/v2/gtfs/realtime/sydneytrains', vehicles: '/v2/gtfs/vehiclepos/sydneytrains' },
  { id: 'metro', mode: 'metro', schedule: '/v2/gtfs/schedule/metro', trips: '/v2/gtfs/realtime/metro', vehicles: '/v2/gtfs/vehiclepos/metro' },
  { id: 'lr-innerwest', mode: 'lightrail', schedule: '/v1/gtfs/schedule/lightrail/innerwest', trips: '/v1/gtfs/realtime/lightrail/innerwest', vehicles: '/v1/gtfs/vehiclepos/lightrail/innerwest' },
  { id: 'lr-cbdse', mode: 'lightrail', schedule: '/v1/gtfs/schedule/lightrail/cbdandsoutheast', trips: '/v1/gtfs/realtime/lightrail/cbdandsoutheast', vehicles: '/v1/gtfs/vehiclepos/lightrail/cbdandsoutheast' },
  { id: 'lr-parramatta', mode: 'lightrail', schedule: '/v1/gtfs/schedule/lightrail/parramatta', trips: '/v1/gtfs/realtime/lightrail/parramatta', vehicles: '/v1/gtfs/vehiclepos/lightrail/parramatta' },
  { id: 'buses', mode: 'bus', schedule: '/v1/gtfs/schedule/buses', trips: '/v1/gtfs/realtime/buses', vehicles: '/v1/gtfs/vehiclepos/buses' },
  { id: 'ferries', mode: 'ferry', schedule: '/v1/gtfs/schedule/ferries/sydneyferries', trips: '/v1/gtfs/realtime/ferries/sydneyferries', vehicles: '/v1/gtfs/vehiclepos/ferries/sydneyferries' },
  { id: 'nswtrains', mode: 'coach', schedule: '/v1/gtfs/schedule/nswtrains', trips: '/v1/gtfs/realtime/nswtrains', vehicles: '/v1/gtfs/vehiclepos/nswtrains' },
];

export function apiKey() {
  const key = process.env.TFNSW_API_KEY;
  if (!key) throw new Error('TFNSW_API_KEY is not set');
  return key;
}

export async function tfnswFetch(path, { timeoutMs = 20000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API_BASE + path, {
      headers: { Authorization: `apikey ${apiKey()}`, Accept: 'application/x-google-protobuf, application/zip, */*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The free tier allows 5 requests a second; back off once if we trip it.
    if ((res.status === 429 || res.status === 403) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res;
  }
}
