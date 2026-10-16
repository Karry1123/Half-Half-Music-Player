import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Accounts, mountAccounts, wrapPostgres } from '../music-service/src/accounts.js';
const express = createRequire(new URL('../music-service/package.json', import.meta.url))('express');

test('PostgreSQL listening schema and absolute upserts match SQLite semantics', async () => {
  const { PGlite } = createRequire(new URL('../music-service/package.json', import.meta.url))('@electric-sql/pglite');
  const pg = new PGlite();
  const accounts = new Accounts(wrapPostgres(pg, fn => pg.transaction(tx => fn(wrapPostgres(tx)))));
  try {
    await accounts.migrate();
    const { user } = await accounts.register('pg-listening', 'local-test-password');
    const day = new Date().toISOString().slice(0, 10);
    const body = { deviceId: 'device-one', records: [{ id: 'r', key: 'hash:abc', day, seconds: 12.5, title: 'Song', artist: 'Artist', cover: '' }], coListening: [{ friendId: 'friend', seconds: 5.5 }] };
    await accounts.recordListening(user.id, body);
    await accounts.recordListening(user.id, body);
    await accounts.recordPlays(user.id, { deviceId: body.deviceId, plays: [{ title: 'Song', artist: 'Artist', completed: 2 }] });
    const all = await accounts.listening(user.id);
    assert.equal(all.daily[0].seconds, 12.5);
    assert.equal(all.coListening[0].seconds, 5.5);
    assert.equal(all.completed[0].completed, 2);
    const excluded = await accounts.listening(user.id, body.deviceId);
    assert.deepEqual(excluded.daily, []);
    assert.deepEqual(excluded.coListening, []);
    assert.equal(excluded.completed[0].completed, 0);
  } finally { await pg.close(); }
});

test('listening HTTP routes isolate accounts, merge devices, reject invalid data and tolerate retries', async () => {
  const accounts = await Accounts.memory(), app = express();
  app.use(express.json());
  mountAccounts(app, accounts, (_req, _res, next) => next());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = async (path, token, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body && { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const day = new Date().toISOString().slice(0, 10);
  const row = { id: 'same-record-id', key: 'source:shared', title: 'Song', artist: 'Artist', cover: 'https://example.com/cover', day, seconds: 60 };
  const body = { deviceId: 'device-one', records: [row], coListening: [{ friendId: 'friend', seconds: 20 }] };
  try {
    assert.equal((await request('/account/listening')).status, 401);
    assert.equal((await request('/account/listening', '', body)).status, 401);
    const a = await accounts.register('listening-a', 'local-test-password');
    assert.equal((await request('/account/listening', a.token)).status, 403);
    await accounts.activate(a.token, await accounts.invite());
    const b = await accounts.register('listening-b', 'local-test-password');
    await accounts.activate(b.token, await accounts.invite());
    assert.equal((await request('/account/listening', a.token, body, 'PUT')).status, 200);
    await request('/account/listening', a.token, body); // retry
    await request('/account/listening', a.token, { ...body, deviceId: 'device-two', records: [{ ...row, seconds: 90 }], coListening: [{ friendId: 'friend', seconds: 30 }] });
    // A stale snapshot cannot reduce an absolute counter.
    await request('/account/listening', a.token, { ...body, records: [{ ...row, seconds: 10 }], coListening: [{ friendId: 'friend', seconds: 1 }] });
    for (const [deviceId, completed] of [['device-one', 2], ['device-two', 3]]) {
      assert.equal((await request('/account/plays', a.token, { deviceId, plays: [{ title: row.title, artist: row.artist, completed }] })).status, 200);
    }
    const all = (await request('/account/listening', a.token)).data;
    assert.deepEqual(all.daily, [{ day, seconds: 150 }]);
    assert.deepEqual(all.tracks, [{ key: row.key, seconds: 150 }]);
    assert.deepEqual(all.coListening, [{ friendId: 'friend', seconds: 50 }]);
    assert.equal(all.completed[0].key, row.key);
    assert.equal(all.completed[0].completed, 5);
    assert.equal(all.metadata[0].cover, row.cover);
    const one = (await request('/account/listening?deviceId=device-one', a.token)).data;
    assert.equal(one.daily[0].seconds, 90);
    assert.equal(one.completed[0].completed, 3);
    assert.equal(one.coListening[0].seconds, 30);
    const other = (await request('/account/listening', b.token)).data;
    for (const rows of Object.values(other)) assert.deepEqual(rows, []);
    for (const invalid of [
      { ...body, deviceId: {} },
      { ...body, records: Array(201).fill(row) },
      { ...body, records: [{ ...row, seconds: -1 }] },
      { ...body, records: [{ ...row, day: '2026-02-30' }] },
      { ...body, records: [row, row] },
      { ...body, coListening: [{ friendId: 'friend', seconds: '30' }] },
    ]) assert.equal((await request('/account/listening', a.token, invalid)).status, 400);
    assert.equal((await request('/account/listening?deviceId=bad', a.token)).status, 400);
    await request('/account/listening', a.token, { ...body, records: [{ ...row, id: 'ancient', day: '2020-01-01', seconds: 100 }] });
    assert.equal((await request('/account/listening', a.token)).data.daily.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); await accounts.close(); }
});
