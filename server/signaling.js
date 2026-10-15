import { randomUUID, randomBytes } from 'node:crypto';
// 极简 WebSocket 信令 / 房间匹配。
// 信令只负责交换 SDP / ICE，P2P 建好之后音频和控制指令都不再经过服务器。
// 以 noServer 模式挂到任意 http.Server 上（开发时是 Vite 的服务器，生产时是 server/index.js），
// 只接管 /ws 的 upgrade，不影响 Vite HMR 自己的 WebSocket。
import { WebSocketServer } from 'ws';
import { iceConfig } from './ice.js';
import { authorizeAccount } from './accountAccess.js';

/** @type {Map<string, {host: import('ws').WebSocket, guest: import('ws').WebSocket | null}>} */
const rooms = new Map();

function newCode() {
  let code;
  do code = String(Math.floor(100000 + Math.random() * 900000));
  while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function leave(ws) {
  const room = rooms.get(ws.room);
  if (!room) return;
  if (ws.role === 'host') {
    // 房主离开 => 房间解散
    if (room.guest) {
      send(room.guest, { type: 'peer-left', reason: 'host-left' });
      room.guest.room = null;
    }
    rooms.delete(ws.room);
  } else if (room.guest === ws) {
    room.guest = null;
    send(room.host, { type: 'peer-left', reason: 'guest-left' });
  }
  ws.room = null;
  ws.role = null;
}

function onMessage(ws, msg) {
  switch (msg.type) {
    case 'create': {
      leave(ws);
      const code = newCode();
      rooms.set(code, { host: ws, guest: null });
      ws.room = code;
      ws.role = 'host';
      send(ws, { type: 'created', code, iceServers: iceConfig() });
      break;
    }
    case 'join': {
      const code = String(msg.code ?? '');
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: '房间不存在' });
      if (room.host === ws) return send(ws, { type: 'error', message: '不能加入自己创建的房间' });
      if (room.guest) return send(ws, { type: 'error', message: '房间已满（仅限两人）' });
      leave(ws);
      room.guest = ws;
      ws.room = code;
      ws.role = 'guest';
      // 先通知 guest，保证 guest 建好 RTCPeerConnection 后才会收到 host 的 offer
      send(ws, { type: 'joined', code, iceServers: iceConfig() });
      send(room.host, { type: 'peer-joined' });
      break;
    }
    case 'signal': {
      const room = rooms.get(ws.room);
      if (!room) return;
      send(ws.role === 'host' ? room.guest : room.host, { type: 'signal', data: msg.data });
      break;
    }
  }
}

// 已连接的信令多久重新核对一次账号（被注销 / 退出后踢下线），避免每条信令都查一次数据库
export const REAUTH_MS = Number(process.env.SIGNAL_REAUTH_MS) || 30_000;

/** authorize(token)：可以是异步的，抛错 / reject 即拒绝；传 null 关闭账号校验 */
export function attachSignaling(httpServer, path = '/ws', authorize = authorizeAccount, accounts = null) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const online = new Map(), invites = new Map(), sessions = new Map();
  const sockets = id => online.get(id) || new Set();
  const deliver = (id, message) => { for (const client of sockets(id)) send(client, message); };
  const presence = id => ({ type: 'FRIEND_PRESENCE', userId: id, online: sockets(id).size > 0, nowPlaying: [...sockets(id)].find(client => client.nowPlaying)?.nowPlaying || null });
  const broadcastPresence = async id => {
    if (!accounts) return;
    for (const friend of await accounts.friends(id)) if (friend.status === 'accepted') deliver(friend.id, presence(id));
  };
  const socialMessage = async (ws, msg) => {
    if (!accounts || !ws.user?.id) return false;
    const id = ws.user.id;
    if (msg.type === 'PRESENCE_UPDATE') {
      ws.nowPlaying = msg.nowPlaying && typeof msg.nowPlaying === 'object' ? { title: String(msg.nowPlaying.title || '').slice(0, 200), artist: String(msg.nowPlaying.artist || '').slice(0, 200), playing: !!msg.nowPlaying.playing } : null;
      await broadcastPresence(id);
      // Refresh the snapshot too: friendships may have changed since connection.
      for (const friend of await accounts.friends(id)) if (friend.status === 'accepted') send(ws, presence(friend.id));
      return true;
    }
    if (msg.type === 'INVITE_LISTEN_REQUEST') {
      if (!await accounts.areFriends(id, msg.userId)) throw new Error('只有好友才能邀请一起听歌');
      if (!sockets(msg.userId).size) throw new Error('好友当前不在线');
      if ([...invites.values()].some(invite => invite.from === id && invite.to === msg.userId && invite.expires > Date.now())) throw new Error('邀请已发送，请等待好友回应');
      const inviteId = randomUUID(), nickname = (await accounts.profile(id)).nickname || ws.user.username;
      invites.set(inviteId, { from: id, to: msg.userId, host: ws, nickname, expires: Date.now() + 120000 });
      deliver(msg.userId, { type: 'INVITE_LISTEN_REQUEST', inviteId, userId: id, nickname });
      send(ws, { type: 'INVITE_LISTEN_SENT', inviteId, userId: msg.userId });
      return true;
    }
    if (msg.type === 'INVITE_LISTEN_RESPONSE') {
      const invite = invites.get(msg.inviteId);
      if (!invite || invite.to !== id || invite.expires < Date.now()) throw new Error('邀请已过期');
      invites.delete(msg.inviteId);
      if (msg.accept !== true) { send(invite.host, { type: 'INVITE_LISTEN_DECLINED', userId: id }); return true; }
      if (!await accounts.areFriends(id, invite.from) || invite.host.readyState !== invite.host.OPEN) throw new Error('好友已离线或好友关系已变更');
      const sessionId = randomUUID(), ticket = randomBytes(32).toString('base64url'), hostPeer = 'hh-' + randomUUID(), guestPeer = 'hh-' + randomUUID();
      sessions.set(sessionId, { host: invite.host, guest: ws, expires: Date.now() + 120000 });
      const nickname = (await accounts.profile(id)).nickname || ws.user.username;
      send(invite.host, { type: 'LISTEN_SESSION', sessionId, ticket, peerId: hostPeer, remotePeerId: guestPeer, role: 'host', userId: id, nickname });
      send(ws, { type: 'LISTEN_SESSION', sessionId, ticket, peerId: guestPeer, remotePeerId: hostPeer, role: 'guest', userId: invite.from, nickname: invite.nickname });
      return true;
    }
    if (msg.type === 'LISTEN_SESSION_READY') {
      const session = sessions.get(msg.sessionId);
      if (!session || session.expires < Date.now() || session.host !== ws) throw new Error('会话无效');
      send(session.guest, { type: 'LISTEN_SESSION_READY', sessionId: msg.sessionId });
      sessions.delete(msg.sessionId);
      return true;
    }
    return false;
  };
  const tokenOf = (req) => new URL(req.url, 'http://localhost').searchParams.get('token');

  httpServer.on('upgrade', async (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== path) return; // 交给其他 upgrade 监听者（如 Vite HMR）
    if (authorize) {
      try { req.account = await authorize(tokenOf(req)); }
      catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    ws.user = req.account;
    if (accounts && ws.user?.id) {
      const clients = sockets(ws.user.id); clients.add(ws); online.set(ws.user.id, clients);
      broadcastPresence(ws.user.id).catch(e => console.warn('Presence:', e.message));
      accounts.friends(ws.user.id).then(friends => { for (const friend of friends) if (friend.status === 'accepted') send(ws, presence(friend.id)); }).catch(e => console.warn('Presence:', e.message));
    }
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    let checkedAt = Date.now(), checking = null;
    ws.on('message', async (raw) => {
      // 核对进行中时后续消息一起等待同一个结果，消息顺序不变
      if (authorize && (checking || Date.now() - checkedAt > REAUTH_MS)) {
        checking ??= Promise.resolve()
          .then(() => authorize(tokenOf(req)))
          .then(() => { checkedAt = Date.now(); return true; }, () => false)
          .finally(() => (checking = null));
        if (!(await checking)) return ws.close(1008, 'Authentication required');
      }
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      try { if (!(await socialMessage(ws, msg))) onMessage(ws, msg); }
      catch (e) { send(ws, { type: 'error', message: e.message }); }
    });
    ws.on('close', () => {
      leave(ws);
      if (ws.user?.id) {
        const clients = sockets(ws.user.id); clients.delete(ws);
        if (!clients.size) online.delete(ws.user.id);
        broadcastPresence(ws.user.id).catch(e => console.warn('Presence:', e.message));
      }
      for (const [key, invite] of invites) if (invite.host === ws) invites.delete(key);
      for (const [key, session] of sessions) if (session.host === ws || session.guest === ws) sessions.delete(key);
    });
  });

  // 心跳：清理僵尸连接，同时防止反向代理因空闲断开
  const timer = setInterval(() => {
    for (const [key, invite] of invites) if (invite.expires < Date.now()) invites.delete(key);
    for (const [key, session] of sessions) if (session.expires < Date.now()) sessions.delete(key);
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  httpServer.on('close', () => clearInterval(timer));

  return wss;
}
