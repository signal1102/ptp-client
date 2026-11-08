self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text() || "Your order has an update." }; }
  const title = payload.title || "Pass the Plate update";
  const options = {
    body: payload.body || "Your order has a new update.",
    icon: "./plate-icon.svg",
    badge: "./plate-icon.svg",
    tag: payload.orderId ? `ptp-order-${payload.orderId}` : "ptp-update",
    data: { url: payload.url || "./#progress", orderId: payload.orderId || null }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./#progress", self.registration.scope).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin === new URL(target).origin) {
        await client.focus();
        if ("navigate" in client) await client.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
