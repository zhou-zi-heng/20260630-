/* ===== 飞凡AI - Service Worker (v2.7.0) ===== */
/* 离线打开 + 静态资源缓存 */

const CACHE_NAME = 'feifan-ai-v2.7.0';
const PRECACHE = [
    './',
    './index.html',
    './css/main.css?v=2.7.0',
    './css/theme.css?v=2.7.0',
    './js/utils.js?v=2.7.0',
    './js/storage.js?v=2.7.0',
    './js/api.js?v=2.7.0',
    './js/ui.js?v=2.7.0',
    './js/parser.js?v=2.7.0',
    './js/upload.js?v=2.7.0',
    './js/snapshot.js?v=2.7.0',
    './js/archive.js?v=2.7.0',
    './js/workflow.js?v=2.7.0',
    './js/app.js?v=2.7.0',
    './js/parsers/text.js?v=2.7.0',
    './js/parsers/csv.js?v=2.7.0',
    './js/parsers/office.js?v=2.7.0',
    './js/parsers/pdf.js?v=2.7.0',
    './manifest.json',
    './presets.json',
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.allSettled(PRECACHE.map(url =>
                fetch(url, { cache: 'reload' }).then(resp => { if (resp.ok) return cache.put(url, resp); }).catch(() => {})
            ))
        ).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return;
    if (url.origin !== self.location.origin) return;
    e.respondWith(
        fetch(req).then(resp => {
            if (resp && resp.ok) { const copy = resp.clone(); caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {}); }
            return resp;
        }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
});