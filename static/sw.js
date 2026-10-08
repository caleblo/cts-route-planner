/* CTS Route Planner — service worker: cache map tiles + app shell
 * so the map reloads smoothly offline / on repeat visits. */
"use strict";

const TILE_CACHE = "cts-osm-tiles-v1";
const APP_CACHE = "cts-app-shell-v5";
const APP_ASSETS = [
  "/", "/index.html", "/app.css", "/app.js",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];
const MAX_TILES = 2000; // rough cap to bound disk use

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(APP_CACHE).then((c) => c.addAll(APP_ASSETS).catch(() => {}))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![TILE_CACHE, APP_CACHE].includes(k))
        .map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isTile(url) {
  return /tile\.openstreetmap\.org/.test(url) ||
         /\.tile\./.test(url);
}

async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > max) {
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = req.url;

  // Never cache API or document-generation calls
  if (url.includes("/api/")) return;

  // Map tiles: cache-first (stale-while-revalidate-ish)
  if (isTile(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const resp = await fetch(req);
          if (resp && (resp.ok || resp.type === "opaque")) {
            cache.put(req, resp.clone());
            trimCache(TILE_CACHE, MAX_TILES);
          }
          return resp;
        } catch (e) {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  // App shell + Leaflet CDN: cache-first, fall back to network
  if (APP_ASSETS.some((a) => url.endsWith(a) || url === a) ||
      /unpkg\.com\/leaflet/.test(url)) {
    event.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((resp) => {
          const copy = resp.clone();
          caches.open(APP_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return resp;
        }).catch(() => hit)
      )
    );
  }
});
