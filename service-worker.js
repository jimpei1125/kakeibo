// アプリシェルのみをキャッシュするService Worker
// Firestore/Auth/外部API（SwitchBot・Hue・Discord等）へのリクエストは一切傍受しない
const CACHE_NAME = 'kakeibo-shell-v1';

const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './css/tailwind.css',
    './css/app.css',
    './css/calendar.css',
    './css/shopping.css',
    './css/smarthome.css',
    './js/app.js',
    './js/utils.js',
    './js/icons.js',
    './js/dialog.js',
    './js/budget.js',
    './js/chart.js',
    './js/paypay.js',
    './js/calendar.js',
    './js/shopping.js',
    './js/smarthome.js',
    './js/hue.js',
    './js/firebase-config.js',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    // 同一オリジンのGET以外（Firestore/Auth/SwitchBot/Hue/Discord等の外部通信を含む）は素通り
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
        return;
    }

    // ページ遷移: ネットワーク優先、オフライン時はキャッシュ済みシェルを返す
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', clone));
                    return response;
                })
                .catch(() => caches.match('./index.html'))
        );
        return;
    }

    // 静的アセット: キャッシュ優先、裏側でネットワークから更新（stale-while-revalidate）
    event.respondWith(
        caches.match(request).then((cached) => {
            const network = fetch(request).then((response) => {
                if (response && response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                }
                return response;
            }).catch(() => cached);
            return cached || network;
        })
    );
});
