// Google's encoded polyline format (5 decimal places): a compact string for
// a list of [lat, lon] points, used for route shapes on disk and on the wire.
export function encode(points) {
  let out = '';
  let pLat = 0;
  let pLon = 0;
  const put = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const [lat, lon] of points) {
    const a = Math.round(lat * 1e5);
    const b = Math.round(lon * 1e5);
    put(a - pLat);
    put(b - pLon);
    pLat = a;
    pLon = b;
  }
  return out;
}

export function decode(str) {
  const points = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const take = () => {
    let shift = 0;
    let result = 0;
    let b;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += take();
    lon += take();
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}
