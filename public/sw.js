self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (allClients.length) {
      await allClients[0].focus();
      allClients[0].postMessage({ type: 'notification-click' });
      return;
    }
    await clients.openWindow('/');
  })());
});

async function handlePush() {
  let title = 'Новое сообщение';
  let body = 'Откройте Private Chat';

  try {
    const response = await fetch('/api/notifications/pending', {
      credentials: 'include'
    });
    const data = await response.json();
    if (data?.latest) {
      title = data.latest.senderName || title;
      body = data.latest.body || body;
    }
  } catch {
    // fallback
  }

  await self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png'
  });
}
