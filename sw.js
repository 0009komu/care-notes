// オフライン用キャッシュ。ファイルを更新したら VERSION を上げる
const VERSION = 'v17';
const FILES = ['./', './index.html', './app.js', './store.js', './import-cal.js', './places.js', './calendar-export.js', './holidays.js', './push.js', './family.js', './gomi.js', './style.css', './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// ネットにつながっていれば最新を取得し、つながらなければキャッシュを使う
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// 通知サーバーから届いた通知を表示する
self.addEventListener('push', (e) => {
  let msg = { title: 'OurTime', body: '予定の時間が近づいています' };
  try { if (e.data) msg = { ...msg, ...e.data.json() }; } catch { /* 文字だけのとき */ }
  e.waitUntil(self.registration.showNotification(msg.title, { body: msg.body, icon: 'icon-192.png', badge: 'icon-192.png' }));
});
// 通知をタップしたらアプリを開く
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const w = list.find((c) => c.url.startsWith(self.registration.scope));
    return w ? w.focus() : self.clients.openWindow('./');
  }));
});
