import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { attachMusicUpgrade } from '../server/musicProxy.js';

test('production proxy forwards authenticated friends and PeerJS websocket paths', async t => {
  const backend = createServer();
  const wss = new WebSocketServer({ server: backend });
  wss.on('connection', (ws, req) => ws.send(req.url));
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const frontend = createServer();
  attachMusicUpgrade(frontend, `http://127.0.0.1:${backend.address().port}`);
  frontend.listen(0, '127.0.0.1');
  await once(frontend, 'listening');
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await Promise.all([new Promise(resolve => frontend.close(resolve)), new Promise(resolve => backend.close(resolve))]);
  });
  for (const path of ['/ws?token=session', '/peerjs/peerjs?token=session&id=host&key=peerjs']) {
    const ws = new WebSocket(`ws://127.0.0.1:${frontend.address().port}/music-api${path}`);
    const [message] = await once(ws, 'message');
    assert.equal(message.toString(), path);
    ws.close();
    await once(ws, 'close');
  }
});
