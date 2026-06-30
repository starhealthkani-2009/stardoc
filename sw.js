const CACHE_NAME='stardoc-v1';
const APP_SHELL=[
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install',e=>{
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch',e=>{
  // Network-first for Google APIs (always need fresh data), cache-first for app shell
  if(e.request.url.includes('googleapis.com') || e.request.url.includes('google.com')){
    return; // let these go straight to network
  }
  e.respondWith(
    caches.match(e.request).then(cached=>cached || fetch(e.request))
  );
});
