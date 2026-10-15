import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { authorizePeerRequest, createAuthenticatedPeerWebSocket } from '../../server/peerAuth.js';

test('peer authentication requires an activated account and rejects missing/revoked tokens', async () => {
  const accounts = { async user(token, activated) { assert.equal(activated, true); if (token !== 'valid') throw new Error('revoked'); return { id: 'u' }; } };
  assert.deepEqual(await authorizePeerRequest({ url: '/peerjs/peerjs?token=valid' }, { accounts, env: {} }), { id: 'u' });
  await assert.rejects(authorizePeerRequest({ url: '/peerjs/peerjs' }, { accounts, env: {} }));
  await assert.rejects(authorizePeerRequest({ url: '/peerjs/peerjs?token=revoked' }, { accounts, env: {} }));
});
test('legacy peer authentication preserves API_TOKEN behavior', async () => {
  const env = { AUTH_MODE: 'legacy', API_TOKEN: 'secret' };
  await assert.rejects(authorizePeerRequest({ url: '/?token=no' }, { env }));
  await authorizePeerRequest({ url: '/?token=secret' }, { env });
  await authorizePeerRequest({ url: '/' }, { env: { AUTH_MODE: 'legacy' } });
});
test('peer upgrade authenticates before connection and coexists with other WS paths', async t => {
  const server = createServer();
  const wss = createAuthenticatedPeerWebSocket({ server, path: '/peerjs/peerjs' }, { env: { AUTH_MODE: 'legacy', API_TOKEN: 'valid' } });
  wss.on('connection', ws => ws.send('authenticated'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const ws of wss.clients) ws.terminate(); server.close(); });
  const url = `ws://127.0.0.1:${server.address().port}/peerjs/peerjs`;
  const bad = new WebSocket(`${url}?token=bad`);
  const [error] = await once(bad, 'error');
  assert.match(error.message, /401/);
  const good = new WebSocket(`${url}?token=valid`);
  const [message] = await once(good, 'message');
  assert.equal(message.toString(), 'authenticated');
  good.close();
});
