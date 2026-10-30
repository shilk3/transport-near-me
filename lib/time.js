// GTFS times are seconds after "noon minus 12 hours" on the service day, in
// Sydney time. These helpers convert between that and epoch seconds.
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function parts(epochS) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(epochS * 1000)).map((x) => [x.type, x.value]));
  return p;
}

// Sydney calendar date of an instant, as yyyymmdd
export function sydneyDate(epochS) {
  const p = parts(epochS);
  return `${p.year}${p.month}${p.day}`;
}

const starts = new Map();

// Epoch seconds of the GTFS service-day origin for a yyyymmdd date
export function serviceDayStart(yyyymmdd) {
  if (!starts.has(yyyymmdd)) starts.set(yyyymmdd, computeStart(yyyymmdd));
  return starts.get(yyyymmdd);
}

function computeStart(yyyymmdd) {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6);
  const d = +yyyymmdd.slice(6, 8);
  const noonUtc = Date.UTC(y, m - 1, d, 12) / 1000;
  const p = parts(noonUtc);
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000 - noonUtc;
  return noonUtc - offset - 12 * 3600;
}

export function addDays(yyyymmdd, n) {
  const t = Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
}
