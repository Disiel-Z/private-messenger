import { nanoid } from 'nanoid';
import { ChatRoom } from './chat-room.js';

export { ChatRoom };

const SESSION_COOKIE = 'pm_session';
const SESSION_TTL_DAYS = 30;
const PUSH_TTL_SECONDS = 60;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, ctx, url);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json(
        { ok: false, error: error.message || 'Internal error' },
        500
      );
    }
  }
};

async function handleApi(request, env, ctx, url) {
  if (request.method === 'OPTIONS') return corsResponse();

  if (url.pathname === '/api/bootstrap' && request.method === 'POST') {
    return withCors(await bootstrapAdminInvite(request, env));
  }

  if (url.pathname === '/api/register' && request.method === 'POST') {
    return withCors(await registerUser(request, env));
  }

  if (url.pathname === '/api/login' && request.method === 'POST') {
    return withCors(await loginUser(request, env));
  }

  if (url.pathname === '/api/logout' && request.method === 'POST') {
    return withCors(await logoutUser(request, env));
  }

  const session = await requireSession(request, env);
  if (!session.ok) return withCors(session.response);

  if (url.pathname === '/api/me' && request.method === 'GET') {
    return withCors(json({ ok: true, user: session.user }));
  }

  if (url.pathname === '/api/users' && request.method === 'GET') {
    return withCors(await listUsers(env, session.user.id));
  }

  if (url.pathname === '/api/admin/invites' && request.method === 'GET') {
    return withCors(await listInvites(env, session.user));
  }

  if (url.pathname === '/api/admin/invites' && request.method === 'POST') {
    return withCors(await createInvite(request, env, session.user));
  }

  if (url.pathname === '/api/subscriptions' && request.method === 'POST') {
    return withCors(await saveSubscription(request, env, session.user));
  }

  if (url.pathname === '/api/subscriptions' && request.method === 'DELETE') {
    return withCors(await deleteSubscription(request, env, session.user));
  }

  if (url.pathname === '/api/vapid-public-key' && request.method === 'GET') {
    return withCors(json({ ok: true, publicKey: env.VAPID_PUBLIC_KEY || null }));
  }

  if (url.pathname === '/api/notifications/pending' && request.method === 'GET') {
    return withCors(await getPendingNotifications(env, session.user));
  }

  if (url.pathname.startsWith('/api/rooms/direct/') && request.method === 'POST') {
    const otherUserId = url.pathname.split('/').pop();
    return withCors(await createOrGetDirectRoom(env, session.user, otherUserId));
  }

  if (url.pathname.match(/^\/api\/rooms\/[^/]+\/messages$/) && request.method === 'GET') {
    const roomId = url.pathname.split('/')[3];
    return withCors(await getMessages(env, session.user, roomId, url));
  }

  if (url.pathname.match(/^\/api\/rooms\/[^/]+\/messages$/) && request.method === 'POST') {
    const roomId = url.pathname.split('/')[3];
    return withCors(await postMessage(request, env, ctx, session.user, roomId));
  }

  if (url.pathname.match(/^\/api\/ws\/[^/]+$/)) {
    const roomId = url.pathname.split('/').pop();
    return await connectSocket(request, env, session.user, roomId);
  }

  return withCors(json({ ok: false, error: 'Not found' }, 404));
}

async function bootstrapAdminInvite(request, env) {
  const { secret } = await request.json();
  const expected = env.BOOTSTRAP_SECRET;
  if (!expected) {
    throw new Error('Missing BOOTSTRAP_SECRET secret');
  }
  if (!secret || secret !== expected) {
    return json({ ok: false, error: 'Invalid bootstrap secret' }, 403);
  }

  const existing = await env.DB.prepare('SELECT code FROM invites LIMIT 1').first();
  if (existing) {
    return json({ ok: true, alreadyExists: true, message: 'Bootstrap invite already exists' });
  }

  const adminInviteCode = env.ADMIN_INVITE_CODE || nanoid(20);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO invites (code, created_by_user_id, note, max_uses, used_count, expires_at, disabled, created_at)
     VALUES (?, NULL, 'Initial admin invite', 1, 0, NULL, 0, ?)`
  ).bind(adminInviteCode, now).run();

  return json({ ok: true, inviteCode: adminInviteCode });
}

async function registerUser(request, env) {
  const { inviteCode, username, displayName, password } = await request.json();

  if (!inviteCode || !username || !displayName || !password) {
    return json({ ok: false, error: 'Invite code, username, display name and password are required' }, 400);
  }

  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
    return json({ ok: false, error: 'Username must be 3–24 chars and use letters, numbers or _' }, 400);
  }

  if (String(displayName).trim().length < 2 || String(displayName).trim().length > 40) {
    return json({ ok: false, error: 'Display name must be 2–40 characters' }, 400);
  }

  if (String(password).length < 8) {
    return json({ ok: false, error: 'Password must be at least 8 characters' }, 400);
  }

  const invite = await env.DB.prepare(
    `SELECT code, used_count, max_uses, expires_at, disabled FROM invites WHERE code = ?`
  ).bind(inviteCode.trim()).first();

  if (!invite || invite.disabled) {
    return json({ ok: false, error: 'Invite code is invalid' }, 400);
  }

  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    return json({ ok: false, error: 'Invite code has expired' }, 400);
  }

  if (invite.used_count >= invite.max_uses) {
    return json({ ok: false, error: 'Invite code has already been used up' }, 400);
  }

  const existingUser = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username.trim().toLowerCase()).first();
  if (existingUser) {
    return json({ ok: false, error: 'Username is already taken' }, 409);
  }

  const usersCount = await env.DB.prepare('SELECT COUNT(*) AS total FROM users').first();
  const isFirstUser = Number(usersCount?.total || 0) === 0;

  const userId = nanoid();
  const salt = base64Url(randomBytes(16));
  const passwordHash = await derivePasswordHash(password, salt);
  const now = nowIso();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, password_salt, role, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    ).bind(
      userId,
      username.trim().toLowerCase(),
      displayName.trim(),
      passwordHash,
      salt,
      isFirstUser ? 'admin' : 'member',
      now
    ),
    env.DB.prepare(
      `UPDATE invites SET used_count = used_count + 1 WHERE code = ?`
    ).bind(inviteCode.trim())
  ]);

  return await createSessionResponse(env, userId, request, {
    id: userId,
    username: username.trim().toLowerCase(),
    display_name: displayName.trim(),
    role: isFirstUser ? 'admin' : 'member'
  });
}

async function loginUser(request, env) {
  const { username, password } = await request.json();
  if (!username || !password) {
    return json({ ok: false, error: 'Username and password are required' }, 400);
  }

  const user = await env.DB.prepare(
    `SELECT id, username, display_name, password_hash, password_salt, role, is_active
     FROM users WHERE username = ?`
  ).bind(username.trim().toLowerCase()).first();

  if (!user || !user.is_active) {
    return json({ ok: false, error: 'Invalid login' }, 401);
  }

  const passwordHash = await derivePasswordHash(password, user.password_salt);
  if (passwordHash !== user.password_hash) {
    return json({ ok: false, error: 'Invalid login' }, 401);
  }

  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso(), user.id).run();

  return await createSessionResponse(env, user.id, request, user);
}

async function logoutUser(request, env) {
  const token = getSessionTokenFromRequest(request);
  const response = json({ ok: true });
  if (token) {
    const tokenHash = await sha256Base64Url(token);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }
  clearSessionCookie(response);
  return response;
}

async function requireSession(request, env) {
  const token = getSessionTokenFromRequest(request);
  if (!token) {
    return { ok: false, response: json({ ok: false, error: 'Unauthorized' }, 401) };
  }

  const tokenHash = await sha256Base64Url(token);
  const session = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.id, u.username, u.display_name, u.role, u.is_active
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).bind(tokenHash).first();

  if (!session) {
    return { ok: false, response: json({ ok: false, error: 'Unauthorized' }, 401) };
  }

  if (!session.is_active || new Date(session.expires_at).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return { ok: false, response: json({ ok: false, error: 'Session expired' }, 401) };
  }

  return {
    ok: true,
    user: {
      id: session.id,
      username: session.username,
      displayName: session.display_name,
      role: session.role
    }
  };
}

async function listUsers(env, currentUserId) {
  const result = await env.DB.prepare(
    `SELECT id, username, display_name
     FROM users
     WHERE is_active = 1 AND id != ?
     ORDER BY display_name COLLATE NOCASE ASC`
  ).bind(currentUserId).all();

  const users = (result.results || []).map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name
  }));

  return json({ ok: true, users });
}

async function createInvite(request, env, user) {
  if (user.role !== 'admin') {
    return json({ ok: false, error: 'Forbidden' }, 403);
  }

  const { note, maxUses, expiresAt } = await request.json();
  const code = nanoid(16);
  const createdAt = nowIso();

  await env.DB.prepare(
    `INSERT INTO invites (code, created_by_user_id, note, max_uses, used_count, expires_at, disabled, created_at)
     VALUES (?, ?, ?, ?, 0, ?, 0, ?)`
  ).bind(
    code,
    user.id,
    note?.trim() || null,
    Math.max(1, Number(maxUses || 1)),
    expiresAt || null,
    createdAt
  ).run();

  return json({ ok: true, inviteCode: code });
}

async function listInvites(env, user) {
  if (user.role !== 'admin') {
    return json({ ok: false, error: 'Forbidden' }, 403);
  }

  const result = await env.DB.prepare(
    `SELECT code, note, max_uses, used_count, expires_at, disabled, created_at
     FROM invites ORDER BY created_at DESC`
  ).all();

  return json({ ok: true, invites: result.results || [] });
}

async function createOrGetDirectRoom(env, user, otherUserId) {
  if (!otherUserId || otherUserId === user.id) {
    return json({ ok: false, error: 'Invalid user' }, 400);
  }

  const exists = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').bind(otherUserId).first();
  if (!exists) {
    return json({ ok: false, error: 'User not found' }, 404);
  }

  const [a, b] = [user.id, otherUserId].sort();
  const room = await env.DB.prepare(
    `SELECT id FROM direct_rooms WHERE user_a_id = ? AND user_b_id = ?`
  ).bind(a, b).first();

  if (room?.id) {
    return json({ ok: true, roomId: room.id });
  }

  const roomId = nanoid();
  const now = nowIso();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO direct_rooms (id, user_a_id, user_b_id, created_at) VALUES (?, ?, ?, ?)`
    ).bind(roomId, a, b, now),
    env.DB.prepare(
      `INSERT INTO room_participants (room_id, user_id, joined_at) VALUES (?, ?, ?)`
    ).bind(roomId, a, now),
    env.DB.prepare(
      `INSERT INTO room_participants (room_id, user_id, joined_at) VALUES (?, ?, ?)`
    ).bind(roomId, b, now),
    env.DB.prepare(
      `INSERT INTO read_receipts (room_id, user_id, last_read_message_id, last_read_at) VALUES (?, ?, NULL, NULL)`
    ).bind(roomId, a),
    env.DB.prepare(
      `INSERT INTO read_receipts (room_id, user_id, last_read_message_id, last_read_at) VALUES (?, ?, NULL, NULL)`
    ).bind(roomId, b)
  ]);

  return json({ ok: true, roomId });
}

async function assertRoomMembership(env, userId, roomId) {
  const result = await env.DB.prepare(
    `SELECT 1 AS ok FROM room_participants WHERE room_id = ? AND user_id = ?`
  ).bind(roomId, userId).first();
  return Boolean(result?.ok);
}

async function getMessages(env, user, roomId, url) {
  const isMember = await assertRoomMembership(env, user.id, roomId);
  if (!isMember) return json({ ok: false, error: 'Forbidden' }, 403);

  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
  const before = url.searchParams.get('before');

  const baseSql = `
    SELECT m.id, m.body, m.created_at, m.sender_user_id, u.display_name
    FROM messages m
    JOIN users u ON u.id = m.sender_user_id
    WHERE m.room_id = ?
  `;

  let result;
  if (before) {
    result = await env.DB.prepare(
      `${baseSql} AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`
    ).bind(roomId, before, limit).all();
  } else {
    result = await env.DB.prepare(
      `${baseSql} ORDER BY m.created_at DESC LIMIT ?`
    ).bind(roomId, limit).all();
  }

  const messages = (result.results || []).reverse().map((row) => ({
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    senderUserId: row.sender_user_id,
    senderDisplayName: row.display_name
  }));

  const latest = messages.at(-1);
  if (latest && latest.senderUserId !== user.id) {
    await env.DB.prepare(
      `UPDATE read_receipts SET last_read_message_id = ?, last_read_at = ? WHERE room_id = ? AND user_id = ?`
    ).bind(latest.id, nowIso(), roomId, user.id).run();
  }

  return json({ ok: true, messages });
}

async function postMessage(request, env, ctx, user, roomId) {
  const isMember = await assertRoomMembership(env, user.id, roomId);
  if (!isMember) return json({ ok: false, error: 'Forbidden' }, 403);

  const { body } = await request.json();
  const cleaned = String(body || '').trim();
  if (!cleaned) {
    return json({ ok: false, error: 'Message cannot be empty' }, 400);
  }
  if (cleaned.length > 4000) {
    return json({ ok: false, error: 'Message is too long' }, 400);
  }

  const message = {
    id: nanoid(),
    roomId,
    body: cleaned,
    createdAt: nowIso(),
    senderUserId: user.id,
    senderDisplayName: user.displayName
  };

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, room_id, sender_user_id, body, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(message.id, roomId, user.id, cleaned, message.createdAt),
    env.DB.prepare(
      `UPDATE read_receipts SET last_read_message_id = ?, last_read_at = ? WHERE room_id = ? AND user_id = ?`
    ).bind(message.id, message.createdAt, roomId, user.id)
  ]);

  const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
  ctx.waitUntil(roomStub.fetch('https://chat.internal/broadcast', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'message', message })
  }));

  ctx.waitUntil(sendPushToOtherParticipants(env, roomId, user.id));

  return json({ ok: true, message });
}

async function connectSocket(request, env, user, roomId) {
  const isMember = await assertRoomMembership(env, user.id, roomId);
  if (!isMember) return json({ ok: false, error: 'Forbidden' }, 403);

  if (request.headers.get('Upgrade') !== 'websocket') {
    return json({ ok: false, error: 'Expected WebSocket upgrade' }, 426);
  }

  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
  const headers = new Headers(request.headers);
  headers.set('X-User-Id', user.id);
  headers.set('X-Room-Id', roomId);
  headers.set('X-Display-Name', user.displayName);
  const forwarded = new Request('https://chat.internal/connect', {
    method: request.method,
    headers
  });
  return stub.fetch(forwarded);
}

async function saveSubscription(request, env, user) {
  const { subscription } = await request.json();
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return json({ ok: false, error: 'Invalid push subscription' }, 400);
  }

  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent,
       updated_at = excluded.updated_at`
  ).bind(
    nanoid(),
    user.id,
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth,
    request.headers.get('user-agent') || null,
    now,
    now
  ).run();

  return json({ ok: true });
}

async function deleteSubscription(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const endpoint = body?.endpoint;
  if (!endpoint) return json({ ok: false, error: 'Endpoint is required' }, 400);

  await env.DB.prepare(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`
  ).bind(user.id, endpoint).run();

  return json({ ok: true });
}

async function getPendingNotifications(env, user) {
  const result = await env.DB.prepare(
    `SELECT m.room_id, m.id, m.body, m.created_at, u.display_name AS sender_name
     FROM messages m
     JOIN users u ON u.id = m.sender_user_id
     JOIN room_participants rp ON rp.room_id = m.room_id
     LEFT JOIN read_receipts rr ON rr.room_id = m.room_id AND rr.user_id = rp.user_id
     WHERE rp.user_id = ?
       AND m.sender_user_id != ?
       AND (rr.last_read_at IS NULL OR m.created_at > rr.last_read_at)
     ORDER BY m.created_at DESC
     LIMIT 10`
  ).bind(user.id, user.id).all();

  const unread = result.results || [];
  const latest = unread[0] || null;
  return json({
    ok: true,
    unreadCount: unread.length,
    latest: latest ? {
      roomId: latest.room_id,
      messageId: latest.id,
      body: latest.body,
      createdAt: latest.created_at,
      senderName: latest.sender_name
    } : null
  });
}

async function sendPushToOtherParticipants(env, roomId, senderUserId) {
  const participants = await env.DB.prepare(
    `SELECT DISTINCT ps.endpoint
     FROM room_participants rp
     JOIN push_subscriptions ps ON ps.user_id = rp.user_id
     WHERE rp.room_id = ? AND rp.user_id != ?`
  ).bind(roomId, senderUserId).all();

  const endpoints = (participants.results || []).map((row) => row.endpoint);
  if (!endpoints.length) return;

  for (const endpoint of endpoints) {
    await sendNoPayloadPush(endpoint, env).catch(async (error) => {
      if (String(error?.message || '').includes('410') || String(error?.message || '').includes('404')) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
      }
    });
  }
}

async function sendNoPayloadPush(endpoint, env) {
  if (!env.VAPID_PRIVATE_KEY_PEM || !env.VAPID_PUBLIC_KEY || !env.VAPID_SUBJECT) {
    return;
  }

  const aud = new URL(endpoint).origin;
  const jwt = await createVapidJwt({
    aud,
    sub: env.VAPID_SUBJECT,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60
  }, env.VAPID_PRIVATE_KEY_PEM);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'TTL': String(PUSH_TTL_SECONDS),
      'Urgency': 'normal',
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
    }
  });

  if (!response.ok && response.status !== 201) {
    throw new Error(`Push failed with status ${response.status}`);
  }
}

async function createSessionResponse(env, userId, request, user) {
  const token = base64Url(randomBytes(32));
  const tokenHash = await sha256Base64Url(token);
  const id = nanoid();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const ipHash = await sha256Base64Url(request.headers.get('CF-Connecting-IP') || '');

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    userId,
    tokenHash,
    createdAt,
    expiresAt,
    request.headers.get('user-agent') || null,
    ipHash
  ).run();

  const response = json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name || user.displayName,
      role: user.role
    }
  });

  setSessionCookie(response, token);
  return response;
}

function setSessionCookie(response, token) {
  response.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}`
  );
}

function clearSessionCookie(response) {
  response.headers.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function getSessionTokenFromRequest(request) {
  const cookies = request.headers.get('Cookie') || '';
  for (const part of cookies.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

async function derivePasswordHash(password, saltBase64Url) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: base64UrlToUint8Array(saltBase64Url),
      iterations: 210000
    },
    keyMaterial,
    256
  );

  return base64Url(bits);
}

async function sha256Base64Url(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64Url(digest);
}

async function createVapidJwt(payload, privateKeyPem) {
  const encodedHeader = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'ES256', typ: 'JWT' })));
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const derSignature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await importPkcs8PrivateKey(privateKeyPem),
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64Url(derToJose(derSignature, 64))}`;
}

async function importPkcs8PrivateKey(pem) {
  const clean = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g, '');
  const binary = Uint8Array.from(atob(clean), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binary.buffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

function randomBytes(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return array;
}

function nowIso() {
  return new Date().toISOString();
}

function base64Url(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToUint8Array(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function withCors(response) {
  for (const [key, value] of Object.entries(corsHeaders())) {
    response.headers.set(key, value);
  }
  return response;
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-credentials': 'true'
  };
}

function derToJose(signature, outputLength) {
  const bytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
  if (bytes[0] !== 0x30) return bytes;
  let offset = 2;
  if (bytes[1] & 0x80) offset = 2 + (bytes[1] & 0x7f);
  if (bytes[offset] !== 0x02) throw new Error('Invalid DER signature');
  const rLength = bytes[offset + 1];
  const r = bytes.slice(offset + 2, offset + 2 + rLength);
  offset = offset + 2 + rLength;
  if (bytes[offset] !== 0x02) throw new Error('Invalid DER signature');
  const sLength = bytes[offset + 1];
  const s = bytes.slice(offset + 2, offset + 2 + sLength);
  const paramLength = outputLength / 2;
  const rPadded = leftPad(r, paramLength);
  const sPadded = leftPad(s, paramLength);
  const jose = new Uint8Array(outputLength);
  jose.set(rPadded, 0);
  jose.set(sPadded, paramLength);
  return jose;
}

function leftPad(bytes, size) {
  let value = bytes;
  while (value.length > 0 && value[0] === 0) value = value.slice(1);
  if (value.length === size) return value;
  if (value.length > size) return value.slice(value.length - size);
  const out = new Uint8Array(size);
  out.set(value, size - value.length);
  return out;
}
