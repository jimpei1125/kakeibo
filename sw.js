/**
 * Service Worker
 * アプリシェル（HTML/CSS/JS/アイコン）をキャッシュし、圏外でも起動できるようにする。
 * 同一オリジンのGETリクエストのみ処理し、Firebase等の外部通信には一切介入しない。
 *
 * キャッシュ更新方針: stale-while-revalidate（キャッシュを即返し、裏で最新を取得して
 * 次回以降に反映）。APP_SHELLに含まれるファイルを追加・削除したときのみ
 * CACHE_VERSION を上げて古いキャッシュを破棄する（個々のファイル内容の更新は
 * バージョンを上げなくても自動的に反映される）。
 */

const CACHE_VERSION = 'kakeibo-v1';

const APP_SHELL = [
    './',
    './index.html',
    './callback.html',
    './manifest.webmanifest',
    './css/tailwind.css',
    './css/app.css',
    './css/calendar.css',
    './css/shopping.css',
    './css/smarthome.css',
    './js/app.js',
    './js/budget.js',
    './js/calendar.js',
    './js/chart.js',
    './js/dialog.js',
    './js/firebase-config.js',
    './js/hue.js',
    './js/icons.js',
    './js/paypay.js',
    './js/shopping.js',
    './js/smarthome.js',
    './js/utils.js',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
        // skipWaiting()は呼ばない: 更新は既存タブが全て閉じられた次回起動時に
        // 自然に反映される（開いたままのタブに新旧アセットが混在する事故を防ぐ）
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((name) => name !== CACHE_VERSION).map((name) => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    // 同一オリジンのGETのみ処理（Firestore/認証などの外部通信はブラウザ標準動作に任せる）
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
        return;
    }

    event.respondWith(
        caches.open(CACHE_VERSION).then(async (cache) => {
            const cached = await cache.match(request);

            const networkFetch = fetch(request)
                .then((response) => {
                    if (response.ok) cache.put(request, response.clone());
                    return response;
                })
                .catch(() => cached);

            if (cached) {
                // キャッシュを即返しつつ、裏で最新版を取得してキャッシュを更新
                event.waitUntil(networkFetch);
                return cached;
            }

            return networkFetch;
        })
    );
});
