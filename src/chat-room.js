export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket' && url.pathname === '/connect') {
      const userId = request.headers.get('X-User-Id');
      const roomId = request.headers.get('X-Room-Id');
      const displayName = request.headers.get('X-Display-Name') || 'User';
      if (!userId || !roomId) {
        return new Response('Missing socket identity', { status: 400 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ userId, roomId, displayName });

      server.send(JSON.stringify({
        type: 'system',
        event: 'connected',
        roomId,
        onlineUsers: this.getOnlineUsers()
      }));

      this.broadcast({
        type: 'presence',
        roomId,
        onlineUsers: this.getOnlineUsers()
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const payload = await request.json();
      this.broadcast(payload);
      return json({ ok: true });
    }

    if (url.pathname === '/presence' && request.method === 'GET') {
      return json({ ok: true, onlineUsers: this.getOnlineUsers() });
    }

    return new Response('Not found', { status: 404 });
  }

  webSocketMessage(ws, message) {
    let parsed;
    try {
      parsed = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (parsed?.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }
  }

  webSocketClose() {
    this.broadcast({ type: 'presence', onlineUsers: this.getOnlineUsers() });
  }

  webSocketError() {
    this.broadcast({ type: 'presence', onlineUsers: this.getOnlineUsers() });
  }

  getOnlineUsers() {
    const sockets = this.ctx.getWebSockets();
    const users = [];
    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment();
      if (attachment?.userId) {
        users.push({ userId: attachment.userId, displayName: attachment.displayName || 'User' });
      }
    }
    return dedupeUsers(users);
  }

  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Ignore broken sockets.
      }
    }
  }
}

function dedupeUsers(users) {
  const map = new Map();
  for (const user of users) map.set(user.userId, user);
  return Array.from(map.values());
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
