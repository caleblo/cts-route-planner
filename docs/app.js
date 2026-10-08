/* CTS Route Planner — static (GitHub Pages) build.
 * Everything runs in the browser: Nominatim geocoding, OSRM routing, the
 * route/fuel/time math (ported from the Python backend), and XLSX/CSV/MD/JSON
 * exports as real downloads. No server required.
 */
"use strict";

const LS_KEY = "cts_route_planner_session_v2";
const SESS_KEY = "cts_route_planner_sessions_v1";   // named sessions store (browser)
const NOMINATIM = "https://nominatim.openstreetmap.org";
const OSRM = "https://router.project-osrm.org";

let stops = [];          // {id, name, nickname, lat, lon, service_min, marker}
let routeLayer = null;
let nextId = 1;
let lastPlan = null;     // last generated plan (for downloads)

// ---- Map ----
const map = L.map("map", { preferCanvas: true }).setView([22.39, 113.98], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  crossOrigin: true,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

map.on("click", async (e) => {
  const { lat, lng } = e.latlng;
  setStatus("Looking up address…");
  let name = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  try {
    const d = await reverseGeocode(lat, lng);
    if (d.name) name = d.name;
  } catch (_) {}
  addStop(name, lat, lng);
  setStatus("");
});

// --------------------------------------------------------------------------
// Geo services (called straight from the browser; both send CORS ACAO:*)
// --------------------------------------------------------------------------
let _lastNominatim = 0;
async function nominatimThrottle() {
  const wait = 1100 - (Date.now() - _lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastNominatim = Date.now();
}

async function geocode(query) {
  await nominatimThrottle();
  const url = `${NOMINATIM}/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`;
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  const data = await r.json();
  return data.map((x) => ({
    name: (x.display_name || query).split(",")[0],
    display_name: x.display_name || "",
    lat: parseFloat(x.lat), lon: parseFloat(x.lon),
  }));
}

async function reverseGeocode(lat, lon) {
  await nominatimThrottle();
  const url = `${NOMINATIM}/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;
  try {
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    const data = await r.json();
    const a = data.address || {};
    const name = a.building || a.amenity || a.road || data.name ||
      (data.display_name || "").split(",")[0] || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    return { name, display_name: data.display_name || "" };
  } catch (_) {
    return { name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, display_name: "" };
  }
}

async function osrmTable(coords) {   // coords = [[lat,lon],...]
  const cs = coords.map(([la, lo]) => `${lo},${la}`).join(";");
  const url = `${OSRM}/table/v1/driving/${cs}?annotations=duration,distance`;
  const data = await (await fetch(url)).json();
  if (data.code !== "Ok") throw new Error("OSRM table: " + data.code);
  return { distances: data.distances, durations: data.durations };
}

async function osrmTrip(coords, roundtrip) {
  const cs = coords.map(([la, lo]) => `${lo},${la}`).join(";");
  const url = `${OSRM}/trip/v1/driving/${cs}?source=first&roundtrip=${roundtrip ? "true" : "false"}&overview=false`;
  const data = await (await fetch(url)).json();
  if (data.code !== "Ok") throw new Error("OSRM trip: " + data.code);
  const order = new Array(coords.length).fill(null);
  data.waypoints.forEach((wp, i) => { order[wp.waypoint_index] = i; });
  return order.filter((o) => o !== null);
}

async function osrmRoute(coords) {
  const cs = coords.map(([la, lo]) => `${lo},${la}`).join(";");
  const url = `${OSRM}/route/v1/driving/${cs}?overview=full&geometries=geojson&annotations=false`;
  const data = await (await fetch(url)).json();
  if (data.code !== "Ok") throw new Error("OSRM route: " + data.code);
  const route = data.routes[0];
  return {
    geometry: route.geometry.coordinates.map(([lo, la]) => [la, lo]),
    legs: route.legs.map((l) => ({ distance: l.distance, duration: l.duration })),
    total_distance: route.distance,
    total_duration: route.duration,
  };
}

// --------------------------------------------------------------------------
// Core route-plan math — ported from server.py build_route_plan()
// --------------------------------------------------------------------------
function stopLabel(s) {
  const nick = (s.nickname || "").trim();
  return nick ? nick : (s.name || "Stop");
}

async function buildRoutePlan(stopsIn, fuel, optimize, roundtrip, maxHours, speedKmh) {
  if (stopsIn.length < 2) throw new Error("Need at least 2 stops.");
  maxHours = parseFloat(maxHours) || 7;
  speedKmh = parseFloat(speedKmh) || 0;
  const mPerS = speedKmh > 0 ? speedKmh * 1000 / 3600 : 0;

  const coords = stopsIn.map((s) => [s.lat, s.lon]);
  const { distances, durations } = await osrmTable(coords);

  let order;
  if (optimize && stopsIn.length >= 3) order = await osrmTrip(coords, roundtrip);
  else order = stopsIn.map((_, i) => i);

  const orderedStops = order.map((i) => stopsIn[i]);
  const orderedCoords = orderedStops.map((s) => [s.lat, s.lon]);
  if (roundtrip) orderedCoords.push(orderedCoords[0]);

  const route = await osrmRoute(orderedCoords);

  const price = parseFloat(fuel.price) || 0;
  const economy = parseFloat(fuel.economy) || 0;
  const unit = fuel.unit || "l_per_100km";
  const lPerM = unit === "km_per_l"
    ? (economy ? (1 / economy) / 1000 : 0)
    : (economy / 100) / 1000;

  const legs = route.legs;
  const seqStops = roundtrip ? orderedStops.concat([orderedStops[0]]) : orderedStops;

  const breakdown = [];
  let cumDist = 0, cumDrive = 0, cumService = 0, cumCost = 0;

  const first = orderedStops[0];
  const firstSvc = (parseFloat(first.service_min) || 0) * 60;
  cumService += firstSvc;
  breakdown.push({
    seq: 1, name: stopLabel(first), full_name: first.name || "",
    lat: first.lat, lon: first.lon, leg_from: "— (start)",
    leg_distance_km: 0, leg_drive_min: 0, service_min: round(firstSvc / 60, 1),
    leg_fuel_l: 0, leg_cost: 0, cum_distance_km: 0,
    cum_time_min: round(cumService / 60, 1), cum_cost: 0,
  });

  legs.forEach((leg, idx) => {
    const dest = seqStops[idx + 1];
    const src = seqStops[idx];
    const legDist = leg.distance;
    const legDrive = mPerS > 0 ? legDist / mPerS : leg.duration;
    const legLitres = legDist * lPerM;
    const legCost = legLitres * price;
    const svc = (parseFloat(dest.service_min) || 0) * 60;
    cumDist += legDist; cumDrive += legDrive; cumService += svc; cumCost += legCost;
    breakdown.push({
      seq: idx + 2, name: stopLabel(dest), full_name: dest.name || "",
      lat: dest.lat, lon: dest.lon, leg_from: stopLabel(src),
      leg_distance_km: round(legDist / 1000, 3), leg_drive_min: round(legDrive / 60, 1),
      service_min: round(svc / 60, 1), leg_fuel_l: round(legLitres, 3),
      leg_cost: round(legCost, 2), cum_distance_km: round(cumDist / 1000, 3),
      cum_time_min: round((cumDrive + cumService) / 60, 1), cum_cost: round(cumCost, 2),
    });
  });

  const totalDistKm = route.total_distance / 1000;
  const totalDriveMin = (mPerS > 0 ? route.total_distance / mPerS : route.total_duration) / 60;
  const totalServiceMin = cumService / 60;
  const totalDeliveryMin = totalDriveMin + totalServiceMin;
  const totalLitres = route.total_distance * lPerM;
  const totalCost = totalLitres * price;
  const withinLimit = totalDeliveryMin <= maxHours * 60;

  return {
    generated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    optimize, roundtrip,
    fuel: { price, economy, unit, l_per_m: lPerM, speed_kmh: speedKmh },
    order_indices: order,
    ordered_stops: orderedStops.map((s) => ({
      name: s.name || "", nickname: s.nickname || "", lat: s.lat, lon: s.lon,
      service_min: parseFloat(s.service_min) || 0,
    })),
    matrix: {
      labels: stopsIn.map(stopLabel),
      distances_km: distances.map((row) => row.map((d) => round(d / 1000, 3))),
      durations_min: durations.map((row) => row.map((d) => round(d / 60, 1))),
    },
    breakdown,
    geometry: route.geometry,
    totals: {
      distance_km: round(totalDistKm, 3), drive_min: round(totalDriveMin, 1),
      service_min: round(totalServiceMin, 1), delivery_min: round(totalDeliveryMin, 1),
      delivery_hours: round(totalDeliveryMin / 60, 2), fuel_l: round(totalLitres, 3),
      cost: round(totalCost, 2), num_stops: orderedStops.length,
    },
    shift: {
      max_hours: maxHours, within_limit: withinLimit,
      over_by_min: round(Math.max(0, totalDeliveryMin - maxHours * 60), 1),
    },
  };
}

function round(v, n) { const p = Math.pow(10, n); return Math.round(v * p) / p; }
function fmtHM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

// --------------------------------------------------------------------------
// Stops
// --------------------------------------------------------------------------
function defaultService() {
  const v = parseFloat(document.getElementById("defaultService").value);
  return isNaN(v) ? 10 : v;
}

function addStop(name, lat, lon, opts = {}) {
  const id = nextId++;
  const marker = L.marker([lat, lon], { draggable: true }).addTo(map);
  const stop = {
    id, name,
    nickname: opts.nickname !== undefined ? opts.nickname : name,
    lat: +lat, lon: +lon,
    service_min: opts.service_min !== undefined ? opts.service_min : defaultService(),
    marker,
  };
  marker.on("dragend", () => {
    const p = marker.getLatLng();
    stop.lat = p.lat; stop.lon = p.lng;
    renderStops(); persist();
  });
  stops.push(stop);
  renderStops(); persist();
}

function removeStop(id) {
  const i = stops.findIndex((s) => s.id === id);
  if (i < 0) return;
  map.removeLayer(stops[i].marker);
  stops.splice(i, 1);
  renderStops(); persist();
}

function clearStops() {
  stops.forEach((s) => map.removeLayer(s.marker));
  stops = [];
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  renderStops(); persist();
}

function label(s) { return (s.nickname && s.nickname.trim()) ? s.nickname : s.name; }

function refreshMarkerPopups() {
  stops.forEach((s, i) => {
    const role = i === 0 ? "START" : `Stop ${i + 1}`;
    s.marker.bindPopup(`<b>${role}: ${label(s)}</b><br>${s.name}<br>Service: ${s.service_min} min`);
  });
}

function focusStop(s) {
  if (!s || !s.marker) return;
  map.setView([s.lat, s.lon], Math.max(map.getZoom(), 16), { animate: true });
  s.marker.openPopup();
  const el = s.marker._icon;
  if (el) {
    el.classList.remove("marker-bounce");
    void el.offsetWidth;
    el.classList.add("marker-bounce");
    setTimeout(() => el && el.classList.remove("marker-bounce"), 1200);
  }
  setStatus(`Showing "${label(s)}" on the map.`, "ok");
}

function renderStops() {
  document.getElementById("stopCount").textContent = stops.length;
  const ul = document.getElementById("stopList");
  ul.innerHTML = "";
  stops.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "stop-item";
    li.dataset.id = s.id;
    li.innerHTML = `
      <div class="seqcol">
        <span class="seq ${i === 0 ? "depot" : ""}" draggable="true" title="drag to reorder">${i === 0 ? "S" : i + 1}</span>
        <span class="pin" title="show this stop on the map">📍</span>
      </div>
      <div class="body">
        <input class="nick" value="${escapeAttr(s.nickname)}" title="${escapeAttr(s.name)}" placeholder="nickname"/>
        <div class="meta">
          <span class="co" title="click to show on map">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</span>
          <span class="svc-label">svc</span>
          <input class="svc" type="number" min="0" step="1" value="${s.service_min}"/>
          <span class="svc-label">min</span>
        </div>
      </div>
      <span class="rm" title="remove">✕</span>`;
    ul.appendChild(li);

    li.querySelector(".nick").addEventListener("input", (e) => {
      s.nickname = e.target.value; persist(); refreshMarkerPopups();
    });
    li.querySelector(".svc").addEventListener("input", (e) => {
      s.service_min = parseFloat(e.target.value) || 0; persist();
    });
    li.querySelector(".rm").addEventListener("click", () => removeStop(s.id));
    li.querySelector(".pin").addEventListener("click", () => focusStop(s));
    li.querySelector(".co").addEventListener("click", () => focusStop(s));
  });
  enableDragReorder(ul);
  refreshMarkerPopups();
}

function escapeAttr(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function enableDragReorder(ul) {
  let dragLi = null;
  ul.querySelectorAll(".stop-item").forEach((li) => {
    const handle = li.querySelector(".seq");
    handle.addEventListener("dragstart", () => { dragLi = li; li.classList.add("dragging"); });
    handle.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      const ids = [...ul.querySelectorAll(".stop-item")].map((x) => +x.dataset.id);
      stops.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      renderStops(); persist();
    });
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragLi) return;
      const after = getDragAfter(ul, e.clientY);
      if (after == null) ul.appendChild(dragLi);
      else ul.insertBefore(dragLi, after);
    });
  });
}
function getDragAfter(ul, y) {
  const els = [...ul.querySelectorAll(".stop-item:not(.dragging)")];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: -Infinity }).element;
}

// ---- Search ----
document.getElementById("searchBtn").addEventListener("click", doSearch);
document.getElementById("searchBox").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});
async function doSearch() {
  const q = document.getElementById("searchBox").value.trim();
  if (!q) return;
  setStatus("Searching…");
  const box = document.getElementById("searchResults");
  box.innerHTML = "";
  try {
    const results = await geocode(q);
    setStatus("");
    if (!results.length) { box.innerHTML = '<p class="hint">No results.</p>'; return; }
    results.forEach((res) => {
      const div = document.createElement("div");
      div.className = "search-item";
      div.innerHTML = `<b>${escapeAttr(res.name)}</b><span>${escapeAttr(res.display_name)}</span>`;
      div.addEventListener("click", () => {
        addStop(res.name, res.lat, res.lon);
        map.setView([res.lat, res.lon], 15);
        box.innerHTML = "";
        document.getElementById("searchBox").value = "";
      });
      box.appendChild(div);
    });
  } catch (e) { setStatus("Search failed: " + e.message, "err"); }
}

// ---- Add by coordinates ----
document.getElementById("addCoordBtn").addEventListener("click", () => {
  const lat = parseFloat(document.getElementById("latInput").value);
  const lon = parseFloat(document.getElementById("lonInput").value);
  const nm = document.getElementById("coordName").value.trim();
  if (isNaN(lat) || isNaN(lon)) { setStatus("Enter valid lat/lon.", "err"); return; }
  addStop(nm || `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon);
  map.setView([lat, lon], 14);
  document.getElementById("latInput").value = "";
  document.getElementById("lonInput").value = "";
  document.getElementById("coordName").value = "";
});

document.getElementById("clearBtn").addEventListener("click", clearStops);
document.getElementById("closeResults").addEventListener("click", () =>
  document.getElementById("resultsPanel").classList.add("hidden"));

document.getElementById("applyServiceBtn").addEventListener("click", () => {
  const d = defaultService();
  stops.forEach((s) => { s.service_min = d; });
  renderStops(); persist();
  setStatus(`Set all ${stops.length} stops to ${d} min.`, "ok");
});

// --------------------------------------------------------------------------
// Sessions — stored in the browser (localStorage) since there's no server
// --------------------------------------------------------------------------
function readSessionStore() {
  try { return JSON.parse(localStorage.getItem(SESS_KEY) || "{}"); } catch (_) { return {}; }
}
function writeSessionStore(obj) {
  try { localStorage.setItem(SESS_KEY, JSON.stringify(obj)); } catch (_) {}
}

function refreshSessions() {
  const store = readSessionStore();
  const sel = document.getElementById("sessionSelect");
  sel.innerHTML = '<option value="">— load a saved session —</option>';
  Object.values(store)
    .sort((a, b) => (b.saved_at || "").localeCompare(a.saved_at || ""))
    .forEach((s) => {
      const o = document.createElement("option");
      o.value = s.name;
      const n = (s.data && s.data.stops ? s.data.stops.length : 0);
      o.textContent = `${s.name} (${n} stops, ${(s.saved_at || "").slice(0, 16).replace("T", " ")})`;
      sel.appendChild(o);
    });
}

function currentSessionData() {
  return {
    fuel: {
      price: parseFloat(document.getElementById("fuelPrice").value) || 0,
      economy: parseFloat(document.getElementById("fuelEconomy").value) || 0,
      unit: document.getElementById("fuelUnit").value,
    },
    max_hours: parseFloat(document.getElementById("maxHours").value) || 0,
    speed_kmh: parseFloat(document.getElementById("speedKmh").value) || 0,
    default_service: parseFloat(document.getElementById("defaultService").value) || 0,
    optimize: document.getElementById("optimize").checked,
    roundtrip: document.getElementById("roundtrip").checked,
    stops: stops.map((s) => ({
      name: s.name, nickname: s.nickname, lat: s.lat, lon: s.lon,
      service_min: s.service_min,
    })),
    center: map.getCenter(), zoom: map.getZoom(),
  };
}

function applySessionData(data) {
  if (!data) return;
  if (data.fuel) {
    document.getElementById("fuelPrice").value = data.fuel.price;
    document.getElementById("fuelEconomy").value = data.fuel.economy;
    document.getElementById("fuelUnit").value = data.fuel.unit;
  }
  if (data.max_hours != null) document.getElementById("maxHours").value = data.max_hours;
  if (data.speed_kmh != null) document.getElementById("speedKmh").value = data.speed_kmh;
  if (data.default_service != null)
    document.getElementById("defaultService").value = data.default_service;
  document.getElementById("optimize").checked = data.optimize !== false;
  document.getElementById("roundtrip").checked = !!data.roundtrip;
  stops.forEach((s) => map.removeLayer(s.marker));
  stops = [];
  (data.stops || []).forEach((s) =>
    addStop(s.name, s.lat, s.lon, { nickname: s.nickname, service_min: s.service_min }));
  if (data.center && data.zoom) map.setView([data.center.lat, data.center.lng], data.zoom);
}

function showSaveInfo(html, cls) {
  const el = document.getElementById("saveInfo");
  el.innerHTML = html;
  el.className = "save-info " + (cls || "ok");
}

document.getElementById("saveSessionBtn").addEventListener("click", () => {
  if (!stops.length) { setStatus("Nothing to save — add some stops first.", "err"); return; }
  const name = (document.getElementById("sessionName").value || "").trim()
    || `session_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  document.getElementById("sessionName").value = name;
  const store = readSessionStore();
  store[name] = { name, saved_at: new Date().toISOString(), data: currentSessionData() };
  writeSessionStore(store);
  setStatus(`✔ Session "${name}" saved in this browser.`, "ok");
  showSaveInfo(
    `✔ <b>Saved "${escapeAttr(name)}" in this browser.</b><br>` +
    `It's in the dropdown below and auto-restores on reload. ` +
    `Use <b>Download .json</b> to keep a portable copy.`, "ok");
  refreshSessions();
  setTimeout(() => { document.getElementById("sessionSelect").value = name; }, 50);
});

document.getElementById("downloadSessionBtn").addEventListener("click", () => {
  if (!stops.length) { setStatus("Nothing to download — add some stops first.", "err"); return; }
  const name = (document.getElementById("sessionName").value || "").trim() || "session";
  const safe = name.replace(/[^A-Za-z0-9_\-]+/g, "_").slice(0, 64);
  const rec = { name, saved_at: new Date().toISOString(), data: currentSessionData() };
  downloadBlob(JSON.stringify(rec, null, 2), `${safe}.json`, "application/json");
  setStatus(`⬇ Downloaded ${safe}.json`, "ok");
  showSaveInfo(`⬇ <b>Downloaded "${escapeAttr(safe)}.json"</b> to your Downloads folder.`, "ok");
});

document.getElementById("loadFileBtn").addEventListener("click", () =>
  document.getElementById("loadFileInput").click());
document.getElementById("loadFileInput").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rec = JSON.parse(reader.result);
      const data = rec.data || rec;
      applySessionData(data);
      if (rec.name) document.getElementById("sessionName").value = rec.name;
      persist();
      setStatus(`✔ Loaded "${file.name}" (${(data.stops || []).length} stops).`, "ok");
      showSaveInfo(`✔ <b>Loaded from file:</b> ${escapeAttr(file.name)}`, "ok");
    } catch (err) {
      setStatus("Load failed: invalid JSON file.", "err");
      showSaveInfo("✖ Could not read that file — is it a valid session .json?", "err");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

document.getElementById("loadSessionBtn").addEventListener("click", () => {
  const name = document.getElementById("sessionSelect").value;
  if (!name) { setStatus("Pick a session to load.", "err"); return; }
  const store = readSessionStore();
  const rec = store[name];
  if (!rec) { setStatus("Session not found.", "err"); return; }
  applySessionData(rec.data);
  document.getElementById("sessionName").value = rec.name || "";
  setStatus(`Loaded: ${rec.name}`, "ok");
  persist();
});

// ---- localStorage auto-persist (last working state) ----
let SAVED_SNAPSHOT = null;
try { SAVED_SNAPSHOT = localStorage.getItem(LS_KEY); } catch (_) {}
function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(currentSessionData())); } catch (_) {}
}
function restore() {
  try { if (SAVED_SNAPSHOT) applySessionData(JSON.parse(SAVED_SNAPSHOT)); } catch (_) {}
}
["fuelPrice", "fuelEconomy", "fuelUnit", "optimize", "roundtrip",
 "maxHours", "speedKmh", "defaultService"].forEach((id) =>
  document.getElementById(id).addEventListener("change", persist));

// --------------------------------------------------------------------------
// Generate (compute in-browser) + downloads
// --------------------------------------------------------------------------
document.getElementById("generateBtn").addEventListener("click", generate);
async function generate() {
  if (stops.length < 2) { setStatus("Add at least 2 stops.", "err"); return; }
  const fuel = {
    price: parseFloat(document.getElementById("fuelPrice").value) || 0,
    economy: parseFloat(document.getElementById("fuelEconomy").value) || 0,
    unit: document.getElementById("fuelUnit").value,
  };
  setStatus("Generating route (calling OSRM)…");
  const btn = document.getElementById("generateBtn");
  btn.disabled = true;
  try {
    const plan = await buildRoutePlan(
      stops.map((s) => ({ name: s.name, nickname: s.nickname, lat: s.lat, lon: s.lon, service_min: s.service_min })),
      fuel,
      document.getElementById("optimize").checked,
      document.getElementById("roundtrip").checked,
      document.getElementById("maxHours").value,
      document.getElementById("speedKmh").value);
    lastPlan = plan;
    renderResults(plan);
    drawRoute(plan);
    // Auto-download the XLSX, as requested.
    const fname = downloadXLSX(plan);
    setStatus(`✔ Route generated. Downloaded ${fname}.`, "ok");
  } catch (e) { setStatus("Error: " + e.message, "err"); }
  finally { btn.disabled = false; }
}

function drawRoute(plan) {
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = L.polyline(plan.geometry, { color: "#4f9cff", weight: 5, opacity: .8 }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
}

function renderResults(plan) {
  document.getElementById("resultsPanel").classList.remove("hidden");
  const t = plan.totals, sh = plan.shift;

  const banner = document.getElementById("shiftBanner");
  banner.className = "show " + (sh.within_limit ? "ok" : "bad");
  banner.textContent = sh.within_limit
    ? `✔ Total delivery time ${fmtHM(t.delivery_min)} (${t.delivery_hours.toFixed(2)} h) — within the ${sh.max_hours}-hour limit.`
    : `✖ Total delivery time ${fmtHM(t.delivery_min)} (${t.delivery_hours.toFixed(2)} h) — OVER the ${sh.max_hours}-hour limit by ${fmtHM(sh.over_by_min)}.`;

  document.getElementById("totals").innerHTML = `
    <div class="stat"><div class="v">${t.distance_km.toFixed(1)} km</div><div class="l">Total distance</div></div>
    <div class="stat"><div class="v time">${fmtHM(t.delivery_min)}</div><div class="l">Delivery time (drive+service)</div></div>
    <div class="stat"><div class="v">${t.fuel_l.toFixed(1)} L</div><div class="l">Fuel used</div></div>
    <div class="stat"><div class="v cost">${t.cost.toFixed(2)}</div><div class="l">Total fuel cost</div></div>`;

  // Download buttons (all client-side)
  document.getElementById("downloads").innerHTML =
    `<b>⬇ Downloads:</b> ` +
    `<button class="dl" data-fmt="xlsx">XLSX</button>` +
    `<button class="dl" data-fmt="csv">Breakdown CSV</button>` +
    `<button class="dl" data-fmt="matrix">Matrix CSV</button>` +
    `<button class="dl" data-fmt="md">Markdown</button>` +
    `<button class="dl" data-fmt="json">JSON</button>`;
  document.querySelectorAll("#downloads .dl").forEach((b) =>
    b.addEventListener("click", () => {
      const f = b.dataset.fmt;
      if (f === "xlsx") downloadXLSX(plan);
      else if (f === "csv") downloadBreakdownCSV(plan);
      else if (f === "matrix") downloadMatrixCSV(plan);
      else if (f === "md") downloadMarkdown(plan);
      else if (f === "json") downloadJSON(plan);
    }));

  const bt = document.getElementById("breakdownTable");
  bt.innerHTML = `<thead><tr>
    <th>#</th><th class="l">Stop</th><th class="l">From</th>
    <th>Leg km</th><th>Drive</th><th>Svc</th><th>Leg L</th><th>Leg cost</th>
    <th>Cum km</th><th>Cum time</th><th>Cum cost</th></tr></thead><tbody>` +
    plan.breakdown.map((b) => `<tr>
      <td>${b.seq}</td><td class="l">${escapeAttr(b.name)}</td><td class="l">${escapeAttr(b.leg_from)}</td>
      <td>${b.leg_distance_km.toFixed(2)}</td><td>${b.leg_drive_min.toFixed(1)}</td>
      <td>${b.service_min.toFixed(0)}</td><td>${b.leg_fuel_l.toFixed(2)}</td><td>${b.leg_cost.toFixed(2)}</td>
      <td>${b.cum_distance_km.toFixed(2)}</td><td>${fmtHM(b.cum_time_min)}</td><td>${b.cum_cost.toFixed(2)}</td></tr>`).join("") +
    `<tr class="total"><td></td><td class="l">TOTAL</td><td></td>
      <td>${t.distance_km.toFixed(2)}</td><td>${t.drive_min.toFixed(0)}</td>
      <td>${t.service_min.toFixed(0)}</td><td>${t.fuel_l.toFixed(2)}</td><td>${t.cost.toFixed(2)}</td>
      <td>${t.distance_km.toFixed(2)}</td><td>${fmtHM(t.delivery_min)}</td><td>${t.cost.toFixed(2)}</td></tr></tbody>`;

  const m = plan.matrix;
  const mt = document.getElementById("matrixTable");
  mt.innerHTML = `<thead><tr><th class="l">From \\ To</th>` +
    m.labels.map((l) => `<th>${escapeAttr(l)}</th>`).join("") + `</tr></thead><tbody>` +
    m.distances_km.map((row, i) => `<tr><td class="l">${escapeAttr(m.labels[i])}</td>` +
      row.map((v) => `<td>${v.toFixed(2)}</td>`).join("") + `</tr>`).join("") +
    `</tbody>`;
}

// --------------------------------------------------------------------------
// Download helpers
// --------------------------------------------------------------------------
function downloadBlob(content, filename, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ts() { return new Date().toISOString().slice(0, 19).replace(/[-:T]/g, ""); }

function downloadXLSX(plan) {
  const t = plan.totals, f = plan.fuel, sh = plan.shift;
  const unitLabel = f.unit === "l_per_100km" ? "L/100km" : "km/L";
  const wb = XLSX.utils.book_new();

  // Summary
  const summary = [
    ["Route Plan", plan.generated_at],
    ["Stops", t.num_stops],
    ["Optimized order", plan.optimize ? "yes" : "no"],
    ["Round trip", plan.roundtrip ? "yes" : "no"],
    ["Total distance (km)", t.distance_km],
    ["Avg speed (km/h)", f.speed_kmh ? f.speed_kmh : "OSRM estimate"],
    ["Driving time", fmtHM(t.drive_min)],
    ["Service time", fmtHM(t.service_min)],
    ["TOTAL DELIVERY TIME", `${fmtHM(t.delivery_min)} (${t.delivery_hours.toFixed(2)} h)`],
    [`Within ${sh.max_hours}-hour limit?`, sh.within_limit ? "YES" : `NO — over by ${fmtHM(sh.over_by_min)}`],
    ["Fuel price / L", f.price],
    ["Fuel economy", `${f.economy} ${unitLabel}`],
    ["Total fuel (L)", t.fuel_l],
    ["TOTAL FUEL COST", t.cost],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Summary");

  // Per-stop breakdown
  const bd = [["#", "Stop", "From", "Leg km", "Drive min", "Service min",
    "Leg L", "Leg cost", "Cum km", "Cum time", "Cum cost"]];
  plan.breakdown.forEach((b) => bd.push([b.seq, b.name, b.leg_from, b.leg_distance_km,
    b.leg_drive_min, b.service_min, b.leg_fuel_l, b.leg_cost, b.cum_distance_km,
    fmtHM(b.cum_time_min), b.cum_cost]));
  bd.push(["", "TOTAL", "", t.distance_km, t.drive_min, t.service_min, t.fuel_l, t.cost,
    t.distance_km, fmtHM(t.delivery_min), t.cost]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(bd), "Per-stop breakdown");

  // Distance matrix
  const labels = plan.matrix.labels;
  const dm = [["From \\ To", ...labels]];
  plan.matrix.distances_km.forEach((row, i) => dm.push([labels[i], ...row]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dm), "Distance matrix km");

  // Duration matrix
  const um = [["From \\ To", ...labels]];
  plan.matrix.durations_min.forEach((row, i) => um.push([labels[i], ...row]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(um), "Duration matrix min");

  const fname = `route_${ts()}.xlsx`;
  XLSX.writeFile(wb, fname);
  return fname;
}

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows) {
  // UTF-8 BOM so Excel on Windows reads Chinese correctly
  return "\uFEFF" + rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

function downloadBreakdownCSV(plan) {
  const rows = [["seq", "stop", "full_name", "from", "leg_distance_km", "leg_drive_min",
    "service_min", "leg_fuel_l", "leg_cost", "cum_distance_km", "cum_time_min",
    "cum_cost", "lat", "lon"]];
  plan.breakdown.forEach((b) => rows.push([b.seq, b.name, b.full_name, b.leg_from,
    b.leg_distance_km, b.leg_drive_min, b.service_min, b.leg_fuel_l, b.leg_cost,
    b.cum_distance_km, b.cum_time_min, b.cum_cost, b.lat, b.lon]));
  downloadBlob(toCSV(rows), `route_${ts()}_breakdown.csv`, "text/csv;charset=utf-8");
}

function downloadMatrixCSV(plan) {
  const labels = plan.matrix.labels;
  const rows = [["distance_km / to ->", ...labels]];
  plan.matrix.distances_km.forEach((row, i) => rows.push([labels[i], ...row]));
  rows.push([]);
  rows.push(["duration_min / to ->", ...labels]);
  plan.matrix.durations_min.forEach((row, i) => rows.push([labels[i], ...row]));
  downloadBlob(toCSV(rows), `route_${ts()}_matrix.csv`, "text/csv;charset=utf-8");
}

function downloadJSON(plan) {
  downloadBlob(JSON.stringify(plan, null, 2), `route_${ts()}.json`, "application/json");
}

function downloadMarkdown(plan) {
  const t = plan.totals, f = plan.fuel, sh = plan.shift;
  const unitLabel = f.unit === "l_per_100km" ? "L/100km" : "km/L";
  const shiftMsg = sh.within_limit ? `WITHIN ${sh.max_hours}-hour limit`
    : `OVER ${sh.max_hours}-hour limit by ${fmtHM(sh.over_by_min)}`;
  let md = `# Route Plan — ${plan.generated_at}\n\n## Summary\n\n`;
  md += `- **Stops:** ${t.num_stops}\n`;
  md += `- **Optimized order:** ${plan.optimize ? "yes" : "no"}${plan.roundtrip ? " (round trip)" : ""}\n`;
  md += `- **Total distance:** ${t.distance_km.toFixed(2)} km\n`;
  md += `- **Driving time:** ${fmtHM(t.drive_min)} ${f.speed_kmh ? `(avg ${f.speed_kmh} km/h)` : "(OSRM estimate)"}\n`;
  md += `- **Service time:** ${fmtHM(t.service_min)}\n`;
  md += `- **TOTAL DELIVERY TIME:** **${fmtHM(t.delivery_min)}** (${t.delivery_hours.toFixed(2)} h)\n`;
  md += `- **${sh.max_hours}-hour check:** **${shiftMsg}**\n`;
  md += `- **Fuel price:** ${f.price.toFixed(2)} / L\n`;
  md += `- **Fuel economy:** ${f.economy.toFixed(2)} ${unitLabel}\n`;
  md += `- **Total fuel:** ${t.fuel_l.toFixed(2)} L\n`;
  md += `- **TOTAL FUEL COST:** **${t.cost.toFixed(2)}**\n\n`;
  md += `## Per-stop breakdown\n\n`;
  md += `| # | Stop | From | Leg km | Drive min | Service min | Leg L | Leg cost | Cum km | Cum time | Cum cost |\n`;
  md += `|---|------|------|-------:|----------:|------------:|------:|---------:|-------:|---------:|---------:|\n`;
  plan.breakdown.forEach((b) => {
    md += `| ${b.seq} | ${b.name} | ${b.leg_from} | ${b.leg_distance_km.toFixed(2)} | ${b.leg_drive_min.toFixed(1)} | ${b.service_min.toFixed(1)} | ${b.leg_fuel_l.toFixed(2)} | ${b.leg_cost.toFixed(2)} | ${b.cum_distance_km.toFixed(2)} | ${fmtHM(b.cum_time_min)} | ${b.cum_cost.toFixed(2)} |\n`;
  });
  downloadBlob(md, `route_${ts()}.md`, "text/markdown;charset=utf-8");
}

function setStatus(msg, cls) {
  const el = document.getElementById("status");
  el.textContent = msg; el.className = cls || "";
}

// ---- Init ----
(function init() {
  refreshSessions();
  restore();
})();
