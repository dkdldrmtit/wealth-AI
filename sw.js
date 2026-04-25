// ── OURs Service Worker ──
const CACHE_NAME = 'ours-v5';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700;900&family=Playfair+Display:wght@700;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

// ── 설치: 핵심 파일 캐싱
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      // 외부 폰트/라이브러리는 실패해도 설치 계속
      return cache.addAll(['/index.html']).then(function() {
        return Promise.allSettled(
          STATIC_ASSETS.filter(function(u) { return u !== '/index.html'; })
            .map(function(u) { return cache.add(u).catch(function() {}); })
        );
      });
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// ── 활성화: 오래된 캐시 정리
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
          .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── fetch 전략
self.addEventListener('fetch', function(e) {
  const url = new URL(e.request.url);

  // 1. Cloudflare Workers API 요청 → 항상 네트워크 (캐시 안 함)
  if (url.hostname.includes('workers.dev') || url.pathname.includes('/sync') || url.pathname.includes('/stock') || url.pathname.includes('/realestate') || url.pathname.includes('/exchange') || url.pathname.includes('/pending')) {
    e.respondWith(
      fetch(e.request).catch(function() {
        return new Response(JSON.stringify({ ok: false, error: '오프라인 상태예요' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // 2. Anthropic API → 항상 네트워크
  if (url.hostname === 'api.anthropic.com') {
    e.respondWith(fetch(e.request));
    return;
  }

  // 3. 외부 폰트/CDN → Stale-While-Revalidate
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('cdnjs.cloudflare.com')) {
    e.respondWith(
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.match(e.request).then(function(cached) {
          const networkFetch = fetch(e.request).then(function(res) {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          }).catch(function() { return cached; });
          return cached || networkFetch;
        });
      })
    );
    return;
  }

  // 4. 앱 자체 파일 (index.html 등) → Cache First, 네트워크 fallback
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) {
        // 백그라운드에서 최신 버전 업데이트
        fetch(e.request).then(function(res) {
          if (res.ok) {
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(e.request, res);
            });
          }
        }).catch(function() {});
        return cached;
      }
      return fetch(e.request).then(function(res) {
        if (res.ok) {
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(e.request, res.clone());
          });
        }
        return res;
      }).catch(function() {
        // index.html 오프라인 fallback
        if (e.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('오프라인', { status: 503 });
      });
    })
  );
});

// ── 백그라운드 동기화 (선택적)
self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (e.data && e.data.type === 'CACHE_URLS') {
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(e.data.urls || []);
    });
  }
});

// ── 푸시 알림 수신
self.addEventListener('push', function(e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {}

  var title = data.title || 'Wealth AI';
  var options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
    vibrate: [150, 80, 150],
    tag: data.tag || 'wealth-notif',
    renotify: true,
    requireInteraction: false
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ── 알림 클릭 시 앱 열기
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var targetUrl = (e.notification.data && e.notification.data.url) ? e.notification.data.url : '/';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'NOTIF_CLICK', url: targetUrl });
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
