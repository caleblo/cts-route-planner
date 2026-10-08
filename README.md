# CTS Route Planner

A lightweight web tool for delivery route planning — fuel-cost accounting,
per-stop service time, an optimized stop order, and a max-delivery-time check.
Pin-drop on a map, generate a route, and export a multi-sheet **XLSX** report.

**Two ways to run it:**

| Version | Where | Backend | Reports |
|---|---|---|---|
| **Static** (`docs/`) | **GitHub Pages — live in the browser** | none | downloaded (XLSX/CSV/MD/JSON) |
| **Server** (`server.py`) | run locally with Python | Python stdlib + openpyxl | written to `./routes/` **and** downloadable |

Both compute identical results (same math); they differ only in *where* the
work happens and *how* files are delivered.

---

## 🌐 Live version (GitHub Pages)

The `docs/` folder is a fully self-contained static app. GitHub Pages serves it
directly — no server to run. Everything happens in the browser:

- **Geocoding** → Nominatim (OpenStreetMap)
- **Routing / optimization** → OSRM public API (`/table`, `/trip`, `/route`)
- **Fuel + time math** → computed client-side (ported from `server.py`)
- **XLSX export** → generated in-browser with [SheetJS](https://sheetjs.com)
  and **downloaded** (plus CSV / Markdown / JSON)
- **Sessions** → saved in the browser (localStorage) and/or downloaded as `.json`

To enable it: repo **Settings → Pages → Source: Deploy from a branch →
`main` / `/docs`**. The URL will be `https://<user>.github.io/<repo>/`.

### Features

- **Pin-drop** on an interactive map (Leaflet / OpenStreetMap)
- **Search** any place by name, or add by raw lat/lon
- **Nicknames** per stop (default = the geocoded name; editable)
- **Per-stop service time** (minutes at each stop); "Apply to all"
- **Click 📍** on any saved stop to fly the map to it and open its popup
- **Editable parameters**: max delivery time, average speed, default stop time,
  fuel price, fuel economy (L/100km or km/L)
- **Generate** →
  - distance + duration matrix (OSRM)
  - optimized stop order (OSRM trip)
  - real road route drawn on the map
  - total fuel cost + per-stop cost breakdown
  - total delivery time (driving + service) with a within/over-limit banner
  - **auto-downloads the XLSX**; buttons for CSV / Matrix CSV / Markdown / JSON

### Limitations of the static version

- Sessions live in **your browser** (localStorage), not on a server — use
  **Download .json** / **Load from file…** to move them between machines.
- Nominatim allows ~1 request/second; search/reverse are throttled accordingly.
- Uses the public OSRM demo server (best in populated areas; Hong Kong is fine).

---

## 💻 Server version (`server.py`)

Run this when you want sessions and reports written to disk on your own machine.

### Requirements

- Python 3.8+ (tested on 3.11)
- `openpyxl` (`pip install openpyxl`) — for XLSX export
- Internet access (Nominatim geocoding + OSRM routing)

### Run

```bash
cd route-planner
python server.py                 # http://127.0.0.1:8777
python server.py --port 9000     # custom port
```

### How to use

1. **Add stops** — search a place, enter lat/lon, or **click the map**. The
   first stop is the start/depot.
2. Edit each stop's **nickname** and **service time**; drag the number badge to
   reorder. Click the **📍** to show a stop on the map.
3. Set **parameters** (max hours, speed, default stop time) and **fuel**
   (price, economy, unit).
4. Click **⚡ Generate**. A banner shows total delivery time vs. the limit; the
   results panel shows totals, per-stop breakdown, and the matrix. Report files
   are written to `./routes/`.
5. **Save** the session (writes `./sessions/<name>.json`), or **Download .json**
   / **Load from file…** for portable copies.

### Output files (in `./routes/`)

| File | Contents |
|------|----------|
| `route_YYYYMMDD_HHMMSS.xlsx` | Multi-sheet: Summary, Per-stop breakdown, Distance matrix, Duration matrix |
| `route_....md` | Human-readable report |
| `route_..._breakdown.csv` | Per-stop breakdown (UTF-8 BOM → Excel reads Chinese correctly) |
| `route_..._matrix.csv` | Distance + duration matrices (UTF-8 BOM) |
| `route_....json` | Complete machine-readable plan (incl. route geometry) |

### API

- `GET  /api/geocode?q=<place>`   → `{results:[{name,display_name,lat,lon}]}`
- `GET  /api/reverse?lat=&lon=`   → `{name,display_name}`
- `GET  /api/vehicles`            → `{vehicles:{...}, max_shift_hours}`
- `GET  /api/sessions`            → `{sessions:[{file,name,saved_at,stops}]}`
- `GET  /api/session?file=<f>`    → full session record
- `POST /api/session/save`        → body `{name, data}` → `{saved,path}`
- `POST /api/route`               → full plan JSON + `saved_files`

---

## Fuel cost + delivery-time model (both versions)

```
litres_per_metre = economy / 100 / 1000          # unit = L/100km
litres_per_metre = (1 / economy) / 1000          # unit = km/L
leg_cost        = leg_distance_m * litres_per_metre * price_per_litre

delivery_time   = total_driving_time + sum(service_time per stop)
over_limit      = delivery_time > max_hours
```

Driving time uses the chosen **average speed** (km/h); set speed to **0** to use
OSRM's own duration estimate.

## Credits / data

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Geocoding by [Nominatim](https://nominatim.org/); routing by
  [OSRM](http://project-osrm.org/); maps by [Leaflet](https://leafletjs.com/);
  spreadsheets by [SheetJS](https://sheetjs.com/)
