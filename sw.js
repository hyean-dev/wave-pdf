// Wave PDF service worker: offline app shell + Android share target
const VERSION = 'wavepdf-v1.20.2';
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/state.js', 'js/util.js', 'js/icons.js', 'js/store.js', 'js/viewer.js', 'js/annots.js',
  'js/pdfio.js', 'js/drive.js', 'js/pages.js', 'js/sign.js', 'js/ai.js', 'js/outline.js', 'js/snap.js', 'js/native.js',
  'vendor/pdf-lib.min.js', 'vendor/fontkit.umd.min.js', 'vendor/Sortable.min.js',
  'vendor/pdfjs-5.7.284/pdf.min.mjs', 'vendor/pdfjs-5.7.284/pdf.worker.min.mjs', 'vendor/pdfjs-5.7.284/pdf_viewer.mjs', 'vendor/pdfjs-5.7.284/pdf_viewer.css',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('wavepdf-v') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const file = fd.getAll('file').find((f) => f && f.size);
        if (file) {
          const c = await caches.open('wavepdf-share');
          await c.put('shared-file', new Response(file, { headers: { 'Content-Type': 'application/pdf', 'X-Name': encodeURIComponent(file.name || 'shared.pdf') } }));
        }
      } catch (err) { /* ignore */ }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const immutable = /\/(vendor|fonts|icons)\//.test(url.pathname);
  if (immutable) {
    // cache-first for libraries, fonts, icons
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok) { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); }
      return r;
    })));
    return;
  }
  // network-first for app code/html so updates arrive immediately
  const key = e.request.mode === 'navigate' ? './' : e.request;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(key, cp)); }
    return r;
  }).catch(() => caches.match(key, { ignoreSearch: true })));
});
