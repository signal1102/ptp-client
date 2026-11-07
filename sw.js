self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const payload = event.data ? event.data.json() : { title: 'Pass the Plate', body: 'Your order has an update.' };

  const options = {
    body: payload.body || 'Your order has an update.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: payload.tag || 'ptp-order-update',
  };

  event.waitUntil(self.registration.showNotification(payload.title || 'Pass the Plate', options));
});
