/*
 * ALBE 予約システム Service Worker（PWA用）
 *
 * 予約システムは「空き状況」「決済」などリアルタイム性が命なので、
 * 動的コンテンツはキャッシュしない安全設計にしている。
 *   - ページ遷移(navigate) : 必ずネットワーク優先。オフライン時のみ offline.html を表示。
 *   - /api/*               : 一切介入しない（常に最新をネットワークから取得）。
 *   - GET以外(POST等)      : 一切介入しない。
 *   - /assets/ の静的ファイル: ネットワーク優先＋失敗時キャッシュ（オフラインでも見た目維持）。
 * これにより「古い空き状況が出る」「決済が二重に走る」等の事故を防ぐ。
 */
const CACHE = 'albe-pwa-v1';
// クリーンURL（拡張子なし）で指定する。Cloudflareのアセットは /offline.html →
// /offline へ307リダイレクトするため、.html を指定すると cache.addAll が失敗する。
const PRECACHE = [
  '/offline',
  '/assets/tokens.css',
  '/assets/albe-header.css',
  '/assets/albe-logo.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // 個別に put する（addAll は1つでも失敗すると全体が失敗＝SWが有効化されない）。
  // allSettled で一部失敗を許容し、確実に install を完了させる。
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled(
        PRECACHE.map((u) =>
          fetch(u, { redirect: 'follow' }).then((res) => {
            if (res && res.ok) return cache.put(u, res);
          }),
        ),
      ),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST等は素通り（決済・予約送信に干渉しない）

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部ドメインは素通り
  if (url.pathname.startsWith('/api/')) return;     // APIは常にネットワーク（最新）

  // ページ遷移：ネットワーク優先、オフライン時のみ offline.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/offline', { ignoreSearch: true })),
    );
    return;
  }

  // 静的アセット（/assets/）：ネットワーク優先＋成功分をキャッシュ更新、失敗時キャッシュ
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }
  // それ以外のGETは素通り（デフォルト動作）
});
