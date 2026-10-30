'use strict';

const MODES = {
  train: { label: 'Trains', color: '#F6891F' },
  metro: { label: 'Metro', color: '#168388' },
  lightrail: { label: 'Light rail', color: '#E4022D' },
  bus: { label: 'Buses', color: '#00B5EF' },
  ferry: { label: 'Ferries', color: '#5AB031' },
  coach: { label: 'Regional', color: '#D6812B' },
};
const REFRESH_MS = 20000;
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
  selected: null,    // trip key
  fetchedAt: 0,
  error: '',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const colorOf = (t) => MODES[t.mode]?.color || '#666';
const label = (t) => t.route.short || t.routeId.split('_').pop() || MODES[t.mode]?.label || '';

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
  return new Date(t * 1000).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
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
  const trips = visibleTrips();
  const live = trips.filter((t) => t.vehicle).length;
  const where = state.followGps ? 'around you' : 'around pin';
  const updated = state.fetchedAt ? ` · ${ago(state.fetchedAt / 1000)}` : '';
  el.textContent = state.error ? state.error : `${trips.length} services, ${live} live ${where}${updated}`;
}

function renderChips() {
  const modes = new Set([...(state.data?.trips || []).map((t) => t.mode), ...(state.data?.stops || []).map((s) => s.mode)]);
  $('chips').innerHTML = Object.entries(MODES).filter(([m]) => modes.has(m)).map(([m, d]) =>
    `<button class="chip" data-mode="${m}" aria-pressed="${!state.hidden.has(m)}"><i style="background:${d.color}"></i>${d.label}</button>`).join('');
}

function routeGroups(trips) {
  // One line per route + destination: the longest remaining path stands in
  // for the others, which keeps a busy corridor readable.
  const groups = new Map();
  for (const t of trips) {
    const k = `${t.feed}:${t.routeId}:${t.destination}`;
    const g = groups.get(k);
    if (!g || t.path.length > g.path.length) groups.set(k, t);
  }
  return [...groups.values()];
}

function renderMap() {
  const d = state.data;
  layers.routes.clearLayers();
  layers.focus.clearLayers();
  layers.stops.clearLayers();
  const trips = visibleTrips();
  const sel = trips.find((t) => t.key === state.selected);

  for (const t of routeGroups(trips)) {
    if (t.path.length < 2) continue;
    L.polyline(t.path, { pane: 'routes', color: colorOf(t), weight: 3, opacity: sel ? 0.15 : 0.55, interactive: false }).addTo(layers.routes);
  }
  if (sel) {
    if (sel.approach.length > 1) L.polyline(sel.approach, { pane: 'routes', color: colorOf(sel), weight: 4, opacity: 0.8, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(layers.focus);
    if (sel.path.length > 1) {
      L.polyline(sel.path, { pane: 'routes', color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(layers.focus);
      L.polyline(sel.path, { pane: 'routes', color: colorOf(sel), weight: 6, opacity: 1, interactive: false }).addTo(layers.focus);
      const end = sel.path[sel.path.length - 1];
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
  for (const t of trips) {
    if (!t.vehicle) continue;
    seen.add(t.key);
    const dim = sel && sel.key !== t.key;
    const html = `<div class="veh${dim ? ' dim' : ''}${sel?.key === t.key ? ' sel' : ''}" style="--c:${colorOf(t)}">` +
      (t.vehicle.bearing != null ? `<div class="arrow" style="transform:rotate(${t.vehicle.bearing}deg)"></div>` : '') +
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

function tripRow(t) {
  const c = t.calls[0];
  const dl = delayText(c.delay);
  const more = t.calls.length > 1 ? ` +${t.calls.length - 1} more nearby` : '';
  return `<li data-key="${esc(t.key)}" class="${t.key === state.selected ? 'sel' : ''}">
    <span class="badge" style="background:${colorOf(t)}">${esc(label(t))}</span>
    <span class="what"><b>${esc(t.destination || t.route.long)}</b><span class="${t.vehicle ? 'live' : ''}">${esc(c.name)}${more}</span></span>
    <span class="when">${mins(c.t)}<small class="${dl.cls}">${dl.text}</small></span></li>`;
}

function renderList() {
  const trips = visibleTrips();
  if (!state.data) { $('list').innerHTML = ''; return; }
  $('list').innerHTML = trips.length
    ? trips.map(tripRow).join('')
    : `<li class="empty">Nothing arriving within ${state.windowMin} min of ${state.data.stops.length} stops in range.</li>`;
}

function renderDetail() {
  const el = $('detail');
  const t = visibleTrips().find((x) => x.key === state.selected);
  if (!t) { el.hidden = true; return; }
  el.hidden = false;
  const v = t.vehicle;
  el.innerHTML = `<header>
      <span class="badge" style="background:${colorOf(t)}">${esc(label(t))}</span>
      <span class="what"><b>to ${esc(t.destination)}</b><span>${esc(t.route.long || MODES[t.mode]?.label)}</span></span>
      <button class="close" data-close aria-label="Close">✕</button>
    </header>
    <ol>${t.calls.map((c) => { const dl = delayText(c.delay); return `<li><span>${esc(c.name)}</span><span><b>${clock(c.t)}</b> <small class="${dl.cls}">${dl.text}</small></span></li>`; }).join('')}</ol>
    <div class="meta">${v ? `<span class="live">Live position ${ago(v.ts)}</span>` : 'No live position yet (probably not departed)'}${v?.label ? ` · ${esc(v.label)}` : ''}</div>`;
}

function select(key, fromMap) {
  state.selected = state.selected === key && fromMap ? null : key;
  render();
  const t = visibleTrips().find((x) => x.key === state.selected);
  if (!t) return;
  const pts = [...t.path, ...(t.vehicle ? [[t.vehicle.lat, t.vehicle.lon]] : [])];
  if (pts.length) {
    const pad = { paddingTopLeft: [30, 80], paddingBottomRight: [30, sheetPx() + 20] };
    map.fitBounds(L.latLngBounds(pts), { ...pad, maxZoom: 16 });
  }
  if (sheetSize === 'min') setSheet('half');
}

function openStop(s) {
  const byKey = new Map((state.data?.trips || []).map((t) => [t.key, t]));
  const rows = s.arrivals.map((a) => byKey.get(a.key)).filter((t) => t && !state.hidden.has(t.mode)).slice(0, 8);
  const own = new Map(s.arrivals.map((a) => [a.key, a.t]));
  const html = `<h3>${esc(s.name)}</h3>` + (rows.length
    ? `<ul>${rows.map((t) => `<li data-key="${esc(t.key)}"><span class="badge" style="background:${colorOf(t)}">${esc(label(t))}</span><span>${esc(t.destination)}</span><b>${mins(own.get(t.key))}</b></li>`).join('')}</ul>`
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
  if (e.target.closest('[data-close]')) { state.selected = null; render(); }
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
  if (state.me) { setCenter(state.me, { gps: true, fly: true }); refresh(); } else startGps(true);
});

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
let watching = false;
function startGps(fly) {
  if (!navigator.geolocation) { noGps('Location not available'); return; }
  if (watching) return;
  watching = true;
  let first = true;
  navigator.geolocation.watchPosition((p) => {
    state.me = [p.coords.latitude, p.coords.longitude];
    layers.me.setLatLng(state.me).addTo(map);
    if (state.followGps || first) {
      const moved = !state.center || map.distance(state.center, state.me) > 100;
      if (first || moved) {
        setCenter(state.me, { gps: true, fly: first || fly });
        refresh();
      }
    }
    first = false;
  }, (err) => { watching = false; noGps(err.code === 1 ? 'Location permission denied' : 'Couldn’t get your location'); },
  { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
}
function noGps(msg) {
  if (state.center) return;
  state.error = `${msg} — showing Sydney CBD. Long-press the map to move.`;
  setCenter(SYDNEY, { fly: true });
  refresh();
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
  startGps(true);
}
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
setInterval(() => { if (state.data) { renderStatus(); renderList(); } }, 15000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - state.fetchedAt > REFRESH_MS / 2) refresh();
});
