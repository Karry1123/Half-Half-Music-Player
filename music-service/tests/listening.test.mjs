import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Accounts, mountAccounts, wrapPostgres } from '../src/accounts.js';
import { ListeningStats, createListeningSync, createCompletedPlayUploader } from '../../public/listeningStats.js';
const express = createRequire(new URL('../package.json', import.meta.url))('express');

for (const identity of ['source', 'hash', 'title']) for (const order of [[0, 1], [1, 0]]) test(`offline devices sum usage after reload: ${identity}, sync order ${order}`, async () => {
  const accounts = await Accounts.memory();
  const { user } = await accounts.register(`offline-${order.join('')}`, 'local-test-password');
  const now = +new Date(2026, 9, 15, 12);
  const titleOf = i => i && identity !== 'title' ? 'Song (alternate tag)' : 'Song';
  const key = identity === 'source' ? 'source:shared' : identity === 'hash' ? 'hash:shared' : '["song","artist"]';
  const devices = [], syncs = [];
  try {
    for (const i of [0, 1]) {
      let saved;
      const persistence = {
        load: async () => structuredClone(saved),
        save: async value => {
          const records = new Map((saved?.records || []).map(r => [r.id, r]));
          value.records.forEach(r => records.set(r.id, r));
          saved = structuredClone({ ...value, records: [...records.values()] });
        },
      };
      let stats = new ListeningStats({ userId: user.id, persistence });
      await stats.ready();
      const trackId = `local-${i}`;
      for (let play = 0; play <= i; play++) {
        stats.sample({ trackId, sourceId: identity === 'source' ? key : '', hash: identity === 'hash' ? 'shared' : '', title: titleOf(i), artist: 'Artist', currentTime: 0, duration: 60, playing: true, connected: true, friendId: 'friend', now: now + play * 61000 });
        stats.sample({ trackId, currentTime: 60, duration: 60, ended: true, connected: true, friendId: 'friend', now: now + play * 61000 + 60000 });
      }
      await stats.flush();
      const deviceId = stats.stats.deviceId;
      stats = new ListeningStats({ userId: user.id, persistence });
      await stats.ready();
      assert.equal(stats.stats.deviceId, deviceId);
      const client = { user: { ...user, isActivated: true }, request: (path, body) =>
        path === '/account/plays' ? accounts.recordPlays(user.id, body) : body ? accounts.recordListening(user.id, body) : accounts.listening(user.id, decodeURIComponent(path.split('=')[1])) };
      const options = { stats, client, listTracks: async () => [] };
      const sync = createListeningSync({ ...options, uploadPlays: createCompletedPlayUploader(options) });
      devices.push(stats); syncs.push(sync);
    }
    assert.notEqual(devices[0].stats.deviceId, devices[1].stats.deviceId);
    for (const i of order) await syncs[i].sync();
    for (const sync of syncs) await sync.sync();
    for (const [i, stats] of devices.entries()) {
      assert.equal(stats.summary('week', now + 180000), 180);
      assert.equal(stats.completedCount(`local-${i}`), 3);
      assert.equal(stats.coListeningSeconds('friend'), 180);
      // A stale snapshot and a new uploader replay must not change any total.
      await accounts.recordListening(user.id, { deviceId: stats.stats.deviceId, records: stats.records.map(r => ({ id: r.id, key, day: '2026-10-15', seconds: 1, title: titleOf(i), artist: 'Artist', cover: '' })), coListening: [{ friendId: 'friend', seconds: 1 }] });
      await accounts.recordPlays(user.id, { deviceId: stats.stats.deviceId, plays: stats.completedUploads().map(p => ({ ...p, completed: 0 })) });
      const options = { stats, client: { user: { ...user, isActivated: true }, request: (path, body) => path === '/account/plays' ? accounts.recordPlays(user.id, body) : body ? accounts.recordListening(user.id, body) : accounts.listening(user.id, stats.stats.deviceId) }, listTracks: async () => [] };
      const replay = createListeningSync({ ...options, uploadPlays: createCompletedPlayUploader(options) });
      try { await replay.sync(); } finally { replay.stop(); }
      assert.equal(stats.summary('week', now + 180000), 180);
      assert.equal(stats.completedCount(`local-${i}`), 3);
      assert.equal(stats.coListeningSeconds('friend'), 180);
    }
    // Clearing the install's IndexedDB discards counters AND identity together.
    const cleared = new ListeningStats({ userId: user.id, indexedDB: null });
    await cleared.ready();
    assert.ok(devices.every(s => s.stats.deviceId !== cleared.stats.deviceId));
    cleared.rememberTrack({ trackId: 'fresh', sourceId: identity === 'source' ? key : '', hash: identity === 'hash' ? 'shared' : '', title: 'Song', artist: 'Artist' });
    assert.deepEqual(cleared.completedUploads(), []);
    cleared.mergeCloud(await accounts.listening(user.id, cleared.stats.deviceId));
    assert.equal(cleared.summary('week', now + 180000), 180);
    assert.equal(cleared.completedCount('fresh'), 3);
    assert.equal(cleared.coListeningSeconds('friend'), 180);
  } finally { syncs.forEach(s => s.stop()); await Promise.all(devices.map(s => s.flush())); await accounts.close(); }
});

test('PostgreSQL listening schema and absolute upserts match SQLite semantics', async () => {
  const { PGlite } = createRequire(new URL('../package.json', import.meta.url))('@electric-sql/pglite');
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
