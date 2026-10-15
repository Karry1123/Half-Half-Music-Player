import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { Accounts } from '../music-service/src/accounts.js';

test('signaling rejects inactive accounts and preserves activated room creation', async () => {
  const db = await Accounts.memory(), server = http.createServer();
  process.env.SIGNAL_REAUTH_MS = '1';
  const { attachSignaling } = await import('../server/signaling.js');
  const wss = attachSignaling(server, '/ws', token => db.user(token, true));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const a = await db.register('signal-test', 'long-local-test-password');
  const url = `ws://127.0.0.1:${server.address().port}/ws?token=${a.token}`;
  let active;
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on('unexpected-response', (_req, res) => { assert.equal(res.statusCode, 401); res.resume(); ws.terminate(); resolve(); });
      ws.on('open', () => { ws.terminate(); reject(new Error('Inactive user admitted')); });
      ws.on('error', () => {});
    });
    await db.activate(a.token, await db.invite());
    active = new WebSocket(url);
    await new Promise((resolve, reject) => { active.once('open', resolve); active.once('error', reject); });
    const reply = new Promise(resolve => active.once('message', data => resolve(JSON.parse(data))));
    active.send(JSON.stringify({ type: 'create' }));
    const room = await reply; assert.equal(room.type, 'created'); assert.match(room.code, /^\d{6}$/);
    await db.logout(a.token);
    await new Promise(r => setTimeout(r, 5)); // past SIGNAL_REAUTH_MS
    const closed = new Promise(resolve => active.once('close', code => resolve(code)));
    active.send(JSON.stringify({ type: 'create' })); assert.equal(await closed, 1008);
  } finally { active?.terminate(); for (const ws of wss.clients) ws.terminate(); wss.close(); await new Promise(r => server.close(r)); await db.close(); }
});
