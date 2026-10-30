'use strict';

const MODES = {
  train: { label: 'Trains', color: '#F6891F' },
  metro: { label: 'Metro', color: '#168388' },
  lightrail: { label: 'Light rail', color: '#E4022D' },
  bus: { label: 'Buses', color: '#00B5EF' },
  ferry: { label: 'Ferries', color: '#5AB031' },
  coach: { label: 'Regional', color: '#D6812B' },
};
const REFRESH_MS = 30000;
const SYDNEY = [-33.8708, 151.2073];
const SHEET = { min: 96, half: 0.45, full: 0.82 };

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  radius: store.get('radius', 1000),
  windowMin: store.get('window', 60),
  hidden: new Set(store.get('hiddenModes', [])),
  me: null,          // last GPS fix
  center: null,      // what we're searching around
  followGps: true,
  data: null,
  selected: null,    // trip key; its service's other runs are listed with it
  fetchedAt: 0,
  error: '',
  locError: '',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const colorOf = (t) => MODES[t.mode]?.color || '#666';
const label = (t) => t.route.short || t.routeId.split('_').pop() || MODES[t.mode]?.label || '';

// Direction of travel in degrees. Trains don't report one, so fall back to
// the direction from the vehicle to its next stop.
function heading(t) {
  if (t.vehicle.bearing != null) return t.vehicle.bearing;
  const next = t.approach[1] || t.path[0];
  if (!next) return null;
  const [lat1, lon1] = [t.vehicle.lat, t.vehicle.lon];
  const [lat2, lon2] = next;
  if (Math.abs(lat2 - lat1) + Math.abs(lon2 - lon1) < 1e-5) return null;
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
const ARROW = '<svg viewBox="0 0 20 16" width="20" height="16"><path d="M10 1 L19 15 L10 11 L1 15 Z" fill="var(--c)" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';

// ---- map ---------------------------------------------------------------
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView(SYDNEY, 15);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Data: Transport for NSW',
}).addTo(map);
map.createPane('routes').style.zIndex = 410;
map.createPane('stops').style.zIndex = 420;
map.createPane('vehicles').style.zIndex = 640;

const layers = {
  circle: L.circle(SYDNEY, { radius: state.radius, color: '#0a6cff', weight: 1.5, fillOpacity: 0.05, interactive: false }).addTo(map),
  me: L.circleMarker(SYDNEY, { radius: 7, color: '#fff', weight: 3, fillColor: '#0a6cff', fillOpacity: 1, interactive: false }),
  routes: L.layerGroup().addTo(map),
  focus: L.layerGroup().addTo(map),
  stops: L.layerGroup().addTo(map),
  vehicles: L.layerGroup().addTo(map),
};
const vehicleMarkers = new Map();

// ---- formatting --------------------------------------------------------
function mins(t) {
  const m = Math.round((t - Date.now() / 1000) / 60);
  return m <= 0 ? 'Now' : `${m} min`;
}
function clock(t) {
  return new Date(t * 1000).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Sydney' });
}
function delayText(d) {
  if (d == null) return { text: 'Scheduled', cls: '' };
  const m = Math.round(d / 60);
  if (m === 0) return { text: 'On time', cls: 'early' };
  return m > 0 ? { text: `${m} min late`, cls: 'late' } : { text: `${-m} min early`, cls: 'early' };
}
function ago(ts) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

// ---- data --------------------------------------------------------------
let inflight = null;
async function refresh() {
  if (!state.center) return;
  inflight?.abort();
  inflight = new AbortController();
  const [lat, lon] = state.center;
  const q = new URLSearchParams({ lat: lat.toFixed(5), lon: lon.toFixed(5), radius: state.radius, window: state.windowMin });
  try {
    const res = await fetch(`api/nearby?${q}`, { signal: inflight.signal });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    state.data = body;
    state.fetchedAt = Date.now();
    state.error = body.failedFeeds?.length ? `Some feeds unavailable (${body.failedFeeds.length})` : '';
    if (state.selected && !body.trips.some((t) => t.key === state.selected)) state.selected = null;
    render();
  } catch (e) {
    if (e.name === 'AbortError') return;
    state.error = `Couldn't load live data: ${e.message}`;
    renderStatus();
  }
}

function visibleTrips() {
  return (state.data?.trips || []).filter((t) => !state.hidden.has(t.mode));
}

// Runs of each service (route + destination), soonest first. Trips arrive
// sorted by time, so the first run of each group is the next one.
function services(trips) {
  const groups = new Map();
  for (const t of trips) {
    if (!groups.has(t.group)) groups.set(t.group, []);
    groups.get(t.group).push(t);
  }
  return groups;
}
const selectedTrip = () => visibleTrips().find((t) => t.key === state.selected);

// ---- rendering ---------------------------------------------------------
function render() {
  renderStatus();
  renderChips();
  renderMap();
  renderList();
  renderDetail();
}

function renderStatus() {
  const el = $('status');
  el.classList.toggle('error', !!state.error && !state.data);
  if (!state.data) { el.textContent = state.error || 'Loading live services…'; return; }
  const groups = [...services(visibleTrips()).values()];
  const live = groups.filter((g) => g[0].vehicle).length;
  const where = state.followGps ? 'around you' : state.locError ? 'around pin (location off)' : 'around pin';
  const updated = state.fetchedAt ? ` · ${ago(state.fetchedAt / 1000)}` : '';
  el.textContent = state.error ? state.error : `${groups.length} services, ${live} live ${where}${updated}`;
}

function renderChips() {
  const modes = new Set([...(state.data?.trips || []).map((t) => t.mode), ...(state.data?.stops || []).map((s) => s.mode)]);
  $('chips').innerHTML = Object.entries(MODES).filter(([m]) => modes.has(m)).map(([m, d]) =>
    `<button class="chip" data-mode="${m}" aria-pressed="${!state.hidden.has(m)}"><i style="background:${d.color}"></i>${d.label}</button>`).join('');
}

function renderMap() {
  const d = state.data;
  layers.routes.clearLayers();
  layers.focus.clearLayers();
  layers.stops.clearLayers();
  const trips = visibleTrips();
  const groups = services(trips);
  const sel = selectedTrip();
  const selPath = sel ? groups.get(sel.group)[0].path : [];

  // Only the next run of each service carries a line (and a vehicle), plus
  // every run of the service that's selected.
  const shown = [...groups.values()].flatMap((g) => (sel && g[0].group === sel.group ? g : g.slice(0, 1)));
  for (const g of groups.values()) {
    if (g[0].path.length < 2) continue;
    L.polyline(g[0].path, { pane: 'routes', color: colorOf(g[0]), weight: 3, opacity: sel ? 0.15 : 0.55, interactive: false }).addTo(layers.routes);
  }
  if (sel) {
    if (sel.approach.length > 1) L.polyline(sel.approach, { pane: 'routes', color: colorOf(sel), weight: 4, opacity: 0.8, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(layers.focus);
    if (selPath.length > 1) {
      L.polyline(selPath, { pane: 'routes', color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(layers.focus);
      L.polyline(selPath, { pane: 'routes', color: colorOf(sel), weight: 6, opacity: 1, interactive: false }).addTo(layers.focus);
      const end = selPath[selPath.length - 1];
      L.circleMarker(end, { pane: 'stops', radius: 7, color: colorOf(sel), weight: 3, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(esc(sel.destination), { permanent: true, direction: 'top', offset: [0, -6] }).addTo(layers.focus);
    }
  }

  const shownModes = new Set(trips.map((t) => t.mode));
  for (const s of d?.stops || []) {
    if (state.hidden.has(s.mode)) continue;
    const station = s.mode !== 'bus';
    const active = s.arrivals.length > 0 || !shownModes.size;
    const onSel = sel && sel.calls.some((c) => c.stopId === s.id);
    L.circleMarker([s.lat, s.lon], {
      pane: 'stops', radius: station ? 7 : 4.5, color: onSel ? '#000' : '#fff', weight: station ? 2.5 : 1.5,
      fillColor: MODES[s.mode]?.color || '#888', fillOpacity: active ? 1 : 0.45,
    }).on('click', () => openStop(s)).addTo(layers.stops);
  }

  const seen = new Set();
  for (const t of shown) {
    if (!t.vehicle) continue;
    seen.add(t.key);
    const dim = sel && sel.group !== t.group;
    const dir = heading(t);
    // Arrow sits just outside the label, so its distance grows with the label
    const reach = 15 + label(t).length * 4.5;
    const html = `<div class="veh${dim ? ' dim' : ''}${sel?.key === t.key ? ' sel' : ''}" style="--c:${colorOf(t)}">` +
      (dir != null ? `<div class="arrow" style="transform:rotate(${dir.toFixed(0)}deg)"><i style="transform:translate(-50%,-${reach}px)">${ARROW}</i></div>` : '') +
      `<div class="tag" style="background:${colorOf(t)}">${esc(label(t))}</div></div>`;
    const icon = L.divIcon({ className: '', html, iconSize: [0, 0] });
    let m = vehicleMarkers.get(t.key);
    if (!m) {
      m = L.marker([t.vehicle.lat, t.vehicle.lon], { icon, pane: 'vehicles' }).on('click', () => select(t.key, true));
      vehicleMarkers.set(t.key, m);
      m.addTo(layers.vehicles);
    } else {
      m.setLatLng([t.vehicle.lat, t.vehicle.lon]).setIcon(icon);
    }
    m.setZIndexOffset(sel?.key === t.key ? 1000 : 0);
  }
  for (const [k, m] of vehicleMarkers) {
    if (!seen.has(k)) { layers.vehicles.removeLayer(m); vehicleMarkers.delete(k); }
  }
}

function serviceRow(runs) {
  const t = runs[0];
  const c = t.calls[0];
  const dl = delayText(c.delay);
  const then = runs.slice(1, 4).map((r) => mins(r.calls[0].t).replace(' min', '')).join(', ');
  const sel = runs.some((r) => r.key === state.selected);
  return `<li data-key="${esc(t.key)}" class="${sel ? 'sel' : ''}">
    <span class="badge" style="background:${colorOf(t)}">${esc(label(t))}</span>
    <span class="what"><b>${esc(t.destination || t.route.long)}</b><span class="${t.vehicle ? 'live' : ''}">${esc(c.name)}</span></span>
    <span class="when">${mins(c.t)}<small class="${dl.cls}">${dl.text}</small>${then ? `<small>then ${then} min</small>` : ''}</span></li>`;
}

function renderList() {
  if (!state.data) { $('list').innerHTML = ''; return; }
  const groups = [...services(visibleTrips()).values()];
  $('list').innerHTML = groups.length
    ? groups.map(serviceRow).join('')
    : `<li class="empty">Nothing arriving within ${state.windowMin} min of ${state.data.stops.length} stops in range.</li>`;
}

function renderDetail() {
  const el = $('detail');
  const t = selectedTrip();
  if (!t) { el.hidden = true; return; }
  el.hidden = false;
  const runs = services(visibleTrips()).get(t.group);
  const v = t.vehicle;
  const run = (r) => {
    const c = r.calls[0];
    const dl = delayText(c.delay);
    return `<li data-run="${esc(r.key)}" class="${r.key === t.key ? 'on' : ''}">
      <span class="${r.vehicle ? 'live' : ''}"><b>${clock(c.t)}</b> · ${mins(c.t)}</span>
      <span class="stop">${esc(c.name)}</span>
      <small class="${dl.cls}">${dl.text}</small></li>`;
  };
  el.innerHTML = `<header>
      <span class="badge" style="background:${colorOf(t)}">${esc(label(t))}</span>
      <span class="what"><b>to ${esc(t.destination)}</b><span>${esc(t.route.long || MODES[t.mode]?.label)}</span></span>
      <button class="close" data-close aria-label="Close">✕</button>
    </header>
    <ol class="runs">${runs.map(run).join('')}</ol>
    <div class="meta">${v ? `<span class="live">Selected run: live position ${ago(v.ts)}</span>` : 'Selected run has no live position yet (probably not departed)'}${v?.label ? ` · ${esc(v.label)}` : ''}</div>`;
}

function select(key, fromMap) {
  state.selected = state.selected === key && fromMap ? null : key;
  render();
  const t = selectedTrip();
  if (!t) return;
  const path = services(visibleTrips()).get(t.group)[0].path;
  const pts = [...path, ...(t.vehicle ? [[t.vehicle.lat, t.vehicle.lon]] : [])];
  if (pts.length) {
    const pad = { paddingTopLeft: [30, 80], paddingBottomRight: [30, sheetPx() + 20] };
    map.fitBounds(L.latLngBounds(pts), { ...pad, maxZoom: 16 });
  }
  if (sheetSize === 'min') setSheet('half');
}

function openStop(s) {
  // Next run of each service at this stop
  const byKey = new Map((state.data?.trips || []).map((t) => [t.key, t]));
  const own = new Map(s.arrivals.map((a) => [a.key, a.t]));
  const seen = new Set();
  const rows = [];
  for (const a of s.arrivals) {
    const t = byKey.get(a.key);
    if (!t || state.hidden.has(t.mode) || seen.has(t.group)) continue;
    seen.add(t.group);
    rows.push(t);
  }
  const html = `<h3>${esc(s.name)}</h3>` + (rows.length
    ? `<ul>${rows.slice(0, 10).map((t) => `<li data-key="${esc(t.key)}"><span class="badge" style="background:${colorOf(t)}">${esc(label(t))}</span><span>${esc(t.destination)}</span><b>${mins(own.get(t.key))}</b></li>`).join('')}</ul>`
    : `<div class="hint">Nothing in the next ${state.windowMin} min.</div>`);
  const popup = L.popup({ offset: [0, -4], autoPanPaddingBottomRight: [10, sheetPx() + 10] }).setLatLng([s.lat, s.lon]).setContent(html).openOn(map);
  popup.getElement().addEventListener('click', (e) => {
    const li = e.target.closest('li[data-key]');
    if (li) { map.closePopup(); select(li.dataset.key); }
  });
}

// ---- sheet -------------------------------------------------------------
let sheetSize = 'half';
function sheetPx() {
  const v = SHEET[sheetSize];
  return v > 1 ? v : Math.round(window.innerHeight * v);
}
function setSheet(size) {
  sheetSize = size;
  $('sheet').dataset.size = size;
  document.documentElement.style.setProperty('--sheet-h', `${sheetPx()}px`);
}
$('handle').addEventListener('click', () => setSheet(sheetSize === 'min' ? 'half' : sheetSize === 'half' ? 'full' : 'min'));
let dragY = null;
$('handle').addEventListener('touchstart', (e) => { dragY = e.touches[0].clientY; }, { passive: true });
$('handle').addEventListener('touchend', (e) => {
  if (dragY == null) return;
  const dy = e.changedTouches[0].clientY - dragY;
  dragY = null;
  if (Math.abs(dy) < 25) return;
  const order = ['min', 'half', 'full'];
  const i = order.indexOf(sheetSize) + (dy < 0 ? 1 : -1);
  setSheet(order[Math.max(0, Math.min(2, i))]);
  e.preventDefault();
});
window.addEventListener('resize', () => setSheet(sheetSize));

// ---- interactions ------------------------------------------------------
$('list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-key]');
  if (li) select(li.dataset.key);
});
$('detail').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) { state.selected = null; render(); return; }
  const r = e.target.closest('[data-run]');
  if (r) select(r.dataset.run);
});
$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  const m = b.dataset.mode;
  state.hidden.has(m) ? state.hidden.delete(m) : state.hidden.add(m);
  store.set('hiddenModes', [...state.hidden]);
  render();
});
map.on('click', () => { if (state.selected) { state.selected = null; render(); } });

function setCenter(latlng, { gps = false, fly = false } = {}) {
  state.center = latlng;
  state.followGps = gps;
  layers.circle.setLatLng(latlng).setRadius(state.radius);
  $('locateBtn').classList.toggle('active', gps);
  if (fly) map.fitBounds(layers.circle.getBounds(), { paddingTopLeft: [10, 60], paddingBottomRight: [10, sheetPx()] });
}

map.on('contextmenu', (e) => {
  setCenter([e.latlng.lat, e.latlng.lng]);
  state.data = null;
  render();
  refresh();
});

$('locateBtn').addEventListener('click', () => {
  if (state.me) { setCenter(state.me, { gps: true, fly: true }); refresh(); return; }
  // Ask again from the tap itself; iOS is more willing to prompt from a user gesture.
  toast('Finding you…');
  locate(true);
});

let toastTimer;
function toast(msg, ms = 4000) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
$('toast').addEventListener('click', () => { $('toast').hidden = true; });

// ---- settings ----------------------------------------------------------
function syncSettings() {
  $('radius').value = state.radius;
  $('window').value = state.windowMin;
  $('radiusOut').textContent = state.radius >= 1000 ? `${state.radius / 1000} km` : `${state.radius} m`;
  $('windowOut').textContent = `${state.windowMin} min`;
}
$('settingsBtn').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
$('closeSettings').addEventListener('click', () => { $('settings').hidden = true; });
let settingsTimer;
for (const id of ['radius', 'window']) {
  $(id).addEventListener('input', () => {
    state.radius = Number($('radius').value);
    state.windowMin = Number($('window').value);
    store.set('radius', state.radius);
    store.set('window', state.windowMin);
    syncSettings();
    layers.circle.setRadius(state.radius);
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(refresh, 400);
  });
}

// ---- location ----------------------------------------------------------
const GPS_OPTS = { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 };
const BLOCKED = 'Location is blocked, so this is the CBD. If you opened this inside another app, open it in Safari instead. '
  + 'In Safari, allow it under Settings → Privacy & Security → Location Services → Safari Websites (While Using), then tap ⌖.';
let watchId = null;

function onFix(p, fly) {
  const first = !state.me;
  state.me = [p.coords.latitude, p.coords.longitude];
  state.locError = '';
  $('toast').hidden = true;
  layers.me.setLatLng(state.me).addTo(map);
  if (!(state.followGps || first || fly)) return;
  if (first || fly || map.distance(state.center, state.me) > 100) {
    setCenter(state.me, { gps: true, fly: first || fly });
    state.data = null;
    render();
    refresh();
  }
}

function onGpsError(err) {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  state.locError = err.code === 1 ? BLOCKED : 'Couldn’t get a GPS fix yet. Tap ⌖ to try again, or long-press the map to pick a spot.';
  toast(state.locError, 0);
  if (!state.center) { setCenter(SYDNEY, { fly: true }); refresh(); }
  renderStatus();
}

function locate(fly) {
  if (!navigator.geolocation) { onGpsError({ code: 1 }); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    onFix(p, fly);
    if (watchId == null) watchId = navigator.geolocation.watchPosition((q) => onFix(q, false), () => {}, GPS_OPTS);
  }, onGpsError, GPS_OPTS);
}

// ---- start -------------------------------------------------------------
syncSettings();
setSheet(window.innerHeight < 600 ? 'min' : 'half');
const pinned = new URLSearchParams(location.search).get('at');
if (pinned) {
  const [lat, lon] = pinned.split(',').map(Number);
  setCenter([lat, lon], { fly: true });
  refresh();
} else {
  locate(true);
}
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
setInterval(() => { if (state.data) { renderStatus(); renderList(); } }, 15000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - state.fetchedAt > REFRESH_MS / 2) refresh();
});
