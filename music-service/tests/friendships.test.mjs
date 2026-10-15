import test from 'node:test';
import assert from 'node:assert/strict';
import { Accounts } from '../src/accounts.js';

async function fixture(t) {
  const accounts = await Accounts.memory();
  t.after(() => accounts.close());
  const users = [];
  for (const name of ['alice', 'bob', 'charlie']) {
    const session = await accounts.register(name, 'correct horse battery staple');
    await accounts.activate(session.token, await accounts.invite());
    users.push(session.user.id);
  }
  return { accounts, users };
}

test('SQLite friendship requests enforce direction, uniqueness and acceptance', async t => {
  const { accounts: a, users: [alice, bob, charlie] } = await fixture(t);
  await a.saveProfile(bob, '小明');
  assert.equal((await a.searchUsers(alice, '小明'))[0].id, bob);
  assert.equal((await a.searchUsers(alice, bob))[0].id, bob);
  assert.deepEqual(await a.searchUsers(alice, '%'), []);
  await assert.rejects(a.requestFriend(alice, alice), { code: 'INPUT' });
  await assert.rejects(a.requestFriend(alice, 'missing'), { code: 'NOT_FOUND' });
  await a.requestFriend(alice, bob);
  await assert.rejects(a.requestFriend(bob, alice), { code: 'FRIEND_EXISTS' });
  assert.equal(await a.areFriends(alice, bob), false);
  assert.equal((await a.friends(bob))[0].requester, alice);
  await assert.rejects(a.respondFriend(alice, bob, true), { code: 'NOT_FOUND' });
  await assert.rejects(a.respondFriend(charlie, alice, true), { code: 'NOT_FOUND' });
  await a.respondFriend(bob, alice, true);
  assert.equal(await a.areFriends(alice, bob), true);
  assert.equal(await a.areFriends(bob, alice), true);
  assert.equal((await a.friends(alice))[0].nickname, '小明');
  await a.removeFriend(charlie, bob);
  assert.equal(await a.areFriends(alice, bob), true);
  await a.removeFriend(bob, alice);
  assert.deepEqual(await a.friends(alice), []);
  await a.requestFriend(bob, alice);
  await a.respondFriend(alice, bob, false);
  assert.deepEqual(await a.friends(bob), []);
});

test('SQLite simultaneous reciprocal requests produce one pending relationship', async t => {
  const { accounts: a, users: [alice, bob] } = await fixture(t);
  const results = await Promise.allSettled([a.requestFriend(alice, bob), a.requestFriend(bob, alice)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await a.friends(alice)).length, 1);
  await a.migrate();
  assert.equal((await a.friends(alice)).length, 1);
});

// Exercise the real authenticated websocket flow, including forged acceptance and readiness.
import http from 'node:http';
import WebSocket from 'ws';
import { attachSignaling } from '../../server/signaling.js';

test('friends presence and private invitations use server IDs and host readiness', async () => {
  const a = await Accounts.memory(), server = http.createServer();
  const wss = attachSignaling(server, '/ws', token => a.user(token, true), a);
  const clients = [];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function connect(name) {
    const session = await a.register(name, 'correct horse battery staple');
    await a.activate(session.token, await a.invite());
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?token=${session.token}`);
    const messages = [];
    ws.on('message', data => messages.push(JSON.parse(data)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const client = { ws, id: session.user.id, messages, send: data => ws.send(JSON.stringify(data)) };
    clients.push(client); return client;
  }
  async function take(client, type) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const index = client.messages.findIndex(message => message.type === type);
      if (index >= 0) return client.messages.splice(index, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Timed out awaiting ' + type);
  }
  try {
    const alice = await connect('ws-alice'), bob = await connect('ws-bob'), eve = await connect('ws-eve');
    alice.send({ type: 'INVITE_LISTEN_REQUEST', userId: bob.id });
    assert.equal((await take(alice, 'error')).type, 'error');
    await a.requestFriend(alice.id, bob.id); await a.respondFriend(bob.id, alice.id, true);
    alice.send({ type: 'PRESENCE_UPDATE', nowPlaying: { title: 'Song', playing: true } });
    const presence = await take(bob, 'FRIEND_PRESENCE');
    assert.equal(presence.userId, alice.id); assert.equal(presence.nowPlaying.title, 'Song');
    alice.send({ type: 'INVITE_LISTEN_REQUEST', userId: bob.id });
    const invitation = await take(bob, 'INVITE_LISTEN_REQUEST');
    eve.send({ type: 'INVITE_LISTEN_RESPONSE', inviteId: invitation.inviteId, accept: true });
    await take(eve, 'error');
    bob.send({ type: 'INVITE_LISTEN_RESPONSE', inviteId: invitation.inviteId, accept: true });
    const host = await take(alice, 'LISTEN_SESSION'), guest = await take(bob, 'LISTEN_SESSION');
    assert.equal(host.role, 'host'); assert.equal(guest.role, 'guest');
    assert.equal(host.sessionId, guest.sessionId); assert.equal(host.ticket, guest.ticket);
    assert.equal(host.remotePeerId, guest.peerId); assert.equal(guest.remotePeerId, host.peerId);
    assert.notEqual(host.peerId, guest.peerId);
    eve.send({ type: 'LISTEN_SESSION_READY', sessionId: host.sessionId }); await take(eve, 'error');
    alice.send({ type: 'LISTEN_SESSION_READY', sessionId: host.sessionId });
    assert.equal((await take(bob, 'LISTEN_SESSION_READY')).sessionId, host.sessionId);
    assert.equal(eve.messages.some(message => message.type === 'FRIEND_PRESENCE'), false);
  } finally {
    const closed = [...wss.clients].map(ws => new Promise(resolve => ws.once('close', resolve)));
    for (const client of clients) client.ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    await Promise.all(closed);
    wss.close(); await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setImmediate(resolve)); await a.close();
  }
});

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('invitation readiness received during ICE fetch survives and dials once', async () => {
  const html = readFileSync(new URL('../../public/dashboard.html', import.meta.url), 'utf8');
  const methods = html.slice(html.indexOf('  async joinInvitation(info, ready) {'), html.indexOf('  async createRoom() {'));
  let resolveIce, dials = 0, stopped = false;
  const ice = new Promise(resolve => { resolveIce = resolve; });
  class FakePeer {
    constructor(id) { this.id = id; this.handlers = {}; }
    on(type, callback) { this.handlers[type] = callback; }
    connect(id, options) { dials++; return { peer: id, metadata: options.metadata }; }
  }
  const context = vm.createContext({ now: () => 0, account: { assertActive: async () => {} }, applyIce: () => ice, Peer: FakePeer, peerOptions: () => ({}), clearTimeout, setTimeout() {}, set() {}, CLIENT_ID: 'client' });
  const Session = vm.runInContext('(class {' + methods + '})', context);
  const session = new Session();
  Object.assign(session, { stopReconnect() {}, destroyPeer() { this.invitation = null; this.invitationReady = null; }, out: { unlock() {}, stopAt() { stopped = true; } }, bind(c) { this.conn = c; } });
  const info = { role: 'guest', sessionId: 'session', peerId: 'guest', remotePeerId: 'host', ticket: 'secret' };
  const joining = session.joinInvitation(info, () => {});
  session.invitationReady = info.sessionId;
  session.dialInvitation(); // Host becomes ready before local ICE resolution.
  resolveIce(); await joining;
  session.peer.open = true; session.peer.handlers.open();
  session.dialInvitation(); // Duplicate readiness cannot create another connection.
  assert.equal(dials, 1);
  assert.equal(stopped, true);
  assert.equal(session.conn.metadata.ticket, 'secret');
  assert.equal(session.conn.metadata.sessionId, 'session');
});
