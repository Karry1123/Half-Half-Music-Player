import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountClient } from '../public/accountClient.js';
import { ListeningStats, createListeningSync, createCompletedPlayUploader } from '../public/listeningStats.js';

test('offline startup restores cached identity before any network dependency', async t => {
  const saved = new Map();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const old = globalThis.localStorage;
  globalThis.localStorage = { getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) };
  t.after(() => { if (old) globalThis.localStorage = old; else delete globalThis.localStorage; });
  const client = new AccountClient('https://test');
  client.request = async () => ({ token: 'token', user: { id: 'alice', isActivated: true } });
  await client.login('alice', 'password');
  const restored = new AccountClient(client.base);
  await restored.init();
  assert.equal(restored.token, 'token');
  assert.equal(restored.user.id, 'alice');
  assert.equal(restored.user.isActivated, true);
  saved.delete(`${client.key}.user`);
  const fallback = new AccountClient(client.base);
  await fallback.init();
  assert.equal(fallback.user.id, 'alice');
});

test('cloud snapshot and device identity survive storage reload and offline sync failure', async () => {
  let saved;
  const persistence = { load: async () => structuredClone(saved), save: async s => { saved = structuredClone(s); } };
  const stats = new ListeningStats({ userId: 'alice', persistence });
  await stats.ready();
  const cloud = { daily: [{ day: '2026-10-15', seconds: 60 }], completed: [], coListening: [] };
  stats.mergeCloud(cloud); await stats.flush();
  const restored = new ListeningStats({ userId: 'alice', persistence });
  await restored.ready();
  assert.equal(restored.stats.deviceId, stats.stats.deviceId);
  assert.deepEqual(restored.cloud, cloud);
  const sync = createListeningSync({ stats: restored, client: { user: { id: 'alice', isActivated: true }, request: async () => { throw new Error('offline'); } }, listTracks: async () => [] });
  try { await assert.rejects(sync.sync(), /offline/); assert.deepEqual(restored.cloud, cloud); }
  finally { sync.stop(); await restored.flush(); }
});

test('large listening and play backlogs share a bounded budget and resume after 429', async () => {
  let now = 0, requests = 0, limited = false;
  const stats = new ListeningStats({ userId: 'alice', indexedDB: null });
  await stats.ready();
  stats.rememberTrack({ trackId: 'song', title: 'Song' });
  stats.records = Array.from({ length: 2001 }, (_, i) => ({ id: String(i), trackId: 'song', timestamp: Date.now(), durationPlayed: 1 }));
  stats.stats.completedPlayCount.song = 1;
  const client = { user: { id: 'alice', isActivated: true }, request: async (path) => {
    requests++;
    if (limited) throw Object.assign(new Error('limited'), { status: 429, retryAfter: 120000 });
    return path.includes('?') ? { daily: [], completed: [], coListening: [] } : {};
  } };
  const options = { stats, client, listTracks: async () => [], now: () => now };
  const uploadPlays = createCompletedPlayUploader(options);
  const sync = createListeningSync({ ...options, uploadPlays });
  try {
    await assert.rejects(sync.sync(), /budget/);
    assert.ok(requests <= 8);
    await assert.rejects(uploadPlays(), /budget/);
    now += 61000; limited = true;
    await assert.rejects(sync.sync(), /limited/);
    const before = requests;
    now += 61000;
    await assert.rejects(sync.sync()); assert.equal(requests, before);
    now += 61000; limited = false;
    await sync.sync();
    assert.ok(requests < 18, 'acknowledged batches are not resent');
  } finally { sync.stop(); }
});

test('large completed-play backlog resumes without resending acknowledged batches', async () => {
  let now = 0;
  const stats = new ListeningStats({ userId: 'alice', indexedDB: null });
  await stats.ready();
  for (let i = 0; i < 1001; i++) {
    stats.rememberTrack({ trackId: String(i), title: `Song ${i}` });
    stats.stats.completedPlayCount[i] = 1;
  }
  const batches = [];
  const client = { user: { id: 'alice', isActivated: true }, request: async (_path, body) => batches.push(body.plays) };
  const upload = createCompletedPlayUploader({ stats, client, listTracks: async () => [], now: () => now });
  await assert.rejects(upload(), /budget/);
  assert.equal(batches.length, 8);
  now += 61000;
  await upload();
  assert.equal(batches.length, 11);
  assert.equal(new Set(batches.flat().map(p => p.title)).size, 1001);
  await upload();
  assert.equal(batches.length, 11);
});

test('recorded calendar days survive timezone changes and a backwards clock adds no time', async () => {
  const stats = new ListeningStats({ userId: 'alice', indexedDB: null });
  await stats.ready();
  const midnight = +new Date(2026, 10, 1);
  stats.sample({ trackId: 'song', title: 'Song', duration: 100, currentTime: 0, playing: true, now: midnight - 5000 });
  stats.sample({ trackId: 'song', duration: 100, currentTime: 10, playing: true, now: midnight + 5000 });
  assert.deepEqual(stats.records.map(r => [r.localDay, r.durationPlayed]), [['2026-10-31', 5], ['2026-11-01', 5]]);
  stats.sample({ trackId: 'song', duration: 100, currentTime: 11, playing: true, now: midnight });
  assert.equal(stats.records.reduce((n, r) => n + r.durationPlayed, 0), 10);
  const uploads = [];
  // Timestamp interpretation can change when travelling; the stored local day cannot.
  stats.records[0].timestamp = midnight + 5000;
  const sync = createListeningSync({ stats, client: { user: { id: 'alice', isActivated: true }, request: async (_path, body) => { if (body) uploads.push(body); return {}; } }, listTracks: async () => [] });
  try {
    await sync.sync();
    assert.deepEqual(uploads[0].records.map(r => r.day), ['2026-10-31', '2026-11-01']);
    assert.equal(stats.summary('month', midnight + 10000), 5);
  } finally { sync.stop(); }
});
