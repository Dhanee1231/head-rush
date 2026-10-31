/* Head Rush service worker: offline shell, faster loads on a weak signal, and streak reminder notifications. */
const CACHE = 'headrush-e9e76d9224';
const CORE = ['./', 'index.html', 'hd3d.js', 'privacy.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/favicon-32.png',
  'vendor/three.module.min.js', 'vendor/addons/environments/RoomEnvironment.js', 'vendor/addons/geometries/RoundedBoxGeometry.js',
  'vendor/addons/postprocessing/EffectComposer.js', 'vendor/addons/postprocessing/MaskPass.js', 'vendor/addons/postprocessing/OutputPass.js',
  'vendor/addons/postprocessing/Pass.js', 'vendor/addons/postprocessing/RenderPass.js', 'vendor/addons/postprocessing/ShaderPass.js',
  'vendor/addons/postprocessing/UnrealBloomPass.js', 'vendor/addons/shaders/CopyShader.js', 'vendor/addons/shaders/LuminosityHighPassShader.js',
  'vendor/addons/shaders/OutputShader.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('headrush-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/')) {
    /* Pages: network first so updates arrive straight away; the cached copy covers a weak or missing signal. */
    e.respondWith(Promise.race([
      fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('index.html', copy)); } return res; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))
    ]).catch(() => caches.match('index.html').then((r) => r || fetch(req))));
    return;
  }
  /* Everything else (code, sounds, icons): cache first, filled in as it is used. */
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Head Rush', { body: d.body || 'Your streak ends at midnight.', icon: 'icons/icon-192.png', badge: 'icons/favicon-32.png', tag: d.tag || 'streak', renotify: true }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./?source=reminder');
  }));
});
