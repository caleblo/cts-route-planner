/* CTS Route Planner — front end logic (v2) */
"use strict";

const API = "";
const LS_KEY = "cts_route_planner_session_v2";
let stops = [];          // {id, name, nickname, lat, lon, service_min, marker}
let routeLayer = null;
let nextId = 1;
let VEHICLES = {};
let MAX_SHIFT_HOURS = 7;

// ---- Service worker (map tile caching for smooth reloads) ----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", { scope: "/" }).catch(() => {});
}

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
    const r = await fetch(`${API}/api/reverse?lat=${lat}&lon=${lng}`);
    const d = await r.json();
    if (d.name) name = d.name;
  } catch (_) {}
  addStop(name, lat, lng);
  setStatus("");
});

// ---- Stops ----
function defaultService() {
  const v = parseFloat(document.getElementById("defaultService").value);
  return isNaN(v) ? 10 : v;
}

function addStop(name, lat, lon, opts = {}) {
  const id = nextId++;
  const marker = L.marker([lat, lon], { draggable: true }).addTo(map);
  const stop = {
    id, name,
    nickname: opts.nickname !== undefined ? opts.nickname : name, // default = suggested
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

// Fly the map to a stop, bounce its marker and open its popup.
function focusStop(s) {
  if (!s || !s.marker) return;
  map.setView([s.lat, s.lon], Math.max(map.getZoom(), 16), { animate: true });
  s.marker.openPopup();
  // brief visual bounce so the right pin is obvious
  const el = s.marker._icon;
  if (el) {
    el.classList.remove("marker-bounce");
    void el.offsetWidth;           // restart the animation
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

// Drag-to-reorder (via the seq handle)
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
    const r = await fetch(`${API}/api/geocode?q=${encodeURIComponent(q)}`);
    const d = await r.json();
    setStatus("");
    if (!d.results || !d.results.length) { box.innerHTML = '<p class="hint">No results.</p>'; return; }
    d.results.forEach((res) => {
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

// ---- Vehicle presets (no selector; just used for the max-shift default) ----
async function loadVehicles() {
  try {
    const r = await fetch(`${API}/api/vehicles`);
    const d = await r.json();
    VEHICLES = d.vehicles || {};
    MAX_SHIFT_HOURS = d.max_shift_hours || 7;
  } catch (_) {}
}

// Apply the default stop time to every existing stop
document.getElementById("applyServiceBtn").addEventListener("click", () => {
  const d = defaultService();
  stops.forEach((s) => { s.service_min = d; });
  renderStops(); persist();
  setStatus(`Set all ${stops.length} stops to ${d} min.`, "ok");
});

// ---- Sessions (server-side) ----
async function refreshSessions() {
  try {
    const r = await fetch(`${API}/api/sessions`);
    const d = await r.json();
    const sel = document.getElementById("sessionSelect");
    sel.innerHTML = '<option value="">— load saved session —</option>';
    (d.sessions || []).forEach((s) => {
      const o = document.createElement("option");
      o.value = s.file;
      o.textContent = `${s.name} (${s.stops} stops, ${s.saved_at.slice(0, 16).replace("T", " ")})`;
      sel.appendChild(o);
    });
  } catch (_) {}
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
  // rebuild stops
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

document.getElementById("saveSessionBtn").addEventListener("click", async () => {
  if (!stops.length) { setStatus("Nothing to save — add some stops first.", "err"); return; }
  const name = (document.getElementById("sessionName").value || "").trim()
    || `session_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  document.getElementById("sessionName").value = name;
  setStatus("Saving session…");
  try {
    const r = await fetch(`${API}/api/session/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, data: currentSessionData() }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    setStatus(`✔ Session "${name}" saved.`, "ok");
    showSaveInfo(
      `✔ <b>Saved as "${escapeAttr(name)}"</b><br>` +
      `File: <code>${escapeAttr(d.path)}</code><br>` +
      `It now appears in the dropdown below, and is auto-restored on reload.`,
      "ok");
    refreshSessions();
    // auto-select the just-saved session in the dropdown
    setTimeout(() => {
      const sel = document.getElementById("sessionSelect");
      [...sel.options].forEach((o) => { if (o.value === d.saved) sel.value = d.saved; });
    }, 300);
  } catch (e) {
    setStatus("Save failed: " + e.message, "err");
    showSaveInfo("✖ Save failed: " + escapeAttr(e.message) +
      " — is the server running? (python server.py)", "err");
  }
});

// Download the current session as a .json file (real browser download)
document.getElementById("downloadSessionBtn").addEventListener("click", () => {
  if (!stops.length) { setStatus("Nothing to download — add some stops first.", "err"); return; }
  const name = (document.getElementById("sessionName").value || "").trim() || "session";
  const safe = name.replace(/[^A-Za-z0-9_\-]+/g, "_").slice(0, 64);
  const rec = { name, saved_at: new Date().toISOString(), data: currentSessionData() };
  const blob = new Blob([JSON.stringify(rec, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${safe}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`⬇ Downloaded ${safe}.json`, "ok");
  showSaveInfo(`⬇ <b>Downloaded "${escapeAttr(safe)}.json"</b> to your browser's Downloads folder.`, "ok");
});

// Load a session from a local .json file (opens the OS file picker)
document.getElementById("loadFileBtn").addEventListener("click", () =>
  document.getElementById("loadFileInput").click());
document.getElementById("loadFileInput").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rec = JSON.parse(reader.result);
      const data = rec.data || rec;   // accept {name,data} or a bare data object
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
  e.target.value = "";  // allow re-loading the same file
});

document.getElementById("loadSessionBtn").addEventListener("click", async () => {
  const file = document.getElementById("sessionSelect").value;
  if (!file) { setStatus("Pick a session to load.", "err"); return; }
  setStatus("Loading session…");
  try {
    const r = await fetch(`${API}/api/session?file=${encodeURIComponent(file)}`);
    const rec = await r.json();
    if (rec.error) throw new Error(rec.error);
    applySessionData(rec.data);
    document.getElementById("sessionName").value = rec.name || "";
    setStatus(`Loaded: ${rec.name}`, "ok");
    persist();
  } catch (e) { setStatus("Load failed: " + e.message, "err"); }
});

// ---- localStorage auto-persist ----
// Snapshot the saved session synchronously at load, BEFORE any async
// init step (loadVehicles -> persist) can overwrite it.
let SAVED_SNAPSHOT = null;
try { SAVED_SNAPSHOT = localStorage.getItem(LS_KEY); } catch (_) {}

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(currentSessionData())); } catch (_) {}
}
function restore() {
  try {
    if (SAVED_SNAPSHOT) applySessionData(JSON.parse(SAVED_SNAPSHOT));
  } catch (_) {}
}
["fuelPrice", "fuelEconomy", "fuelUnit", "optimize", "roundtrip",
 "maxHours", "speedKmh", "defaultService"].forEach((id) =>
  document.getElementById(id).addEventListener("change", persist));

// ---- Generate ----
document.getElementById("generateBtn").addEventListener("click", generate);
async function generate() {
  if (stops.length < 2) { setStatus("Add at least 2 stops.", "err"); return; }
  const payload = {
    stops: stops.map((s) => ({
      name: s.name, nickname: s.nickname, lat: s.lat, lon: s.lon,
      service_min: s.service_min,
    })),
    fuel: {
      price: parseFloat(document.getElementById("fuelPrice").value) || 0,
      economy: parseFloat(document.getElementById("fuelEconomy").value) || 0,
      unit: document.getElementById("fuelUnit").value,
    },
    vehicle: {},
    max_hours: parseFloat(document.getElementById("maxHours").value) || 7,
    speed_kmh: parseFloat(document.getElementById("speedKmh").value) || 0,
    optimize: document.getElementById("optimize").checked,
    roundtrip: document.getElementById("roundtrip").checked,
  };
  setStatus("Generating route (calling OSRM)…");
  const btn = document.getElementById("generateBtn");
  btn.disabled = true;
  try {
    const r = await fetch(`${API}/api/route`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const plan = await r.json();
    if (plan.error) throw new Error(plan.error);
    renderResults(plan);
    drawRoute(plan);
    setStatus("Route generated, XLSX + docs saved.", "ok");
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

  const f = plan.saved_files || {};
  document.getElementById("savedFiles").innerHTML =
    `<b>✔ Saved to:</b> ${plan.saved_dir}` +
    Object.entries(f).map(([k, v]) => `<div>${k}: ${v.split(/[\\/]/).pop()}</div>`).join("");

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

function fmtHM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function setStatus(msg, cls) {
  const el = document.getElementById("status");
  el.textContent = msg; el.className = cls || "";
}

// ---- Init ----
(async function init() {
  await loadVehicles();
  await refreshSessions();
  restore();          // load last browser session if present
})();
