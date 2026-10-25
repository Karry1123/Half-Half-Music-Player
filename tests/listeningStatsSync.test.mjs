import test from 'node:test';
import assert from 'node:assert/strict';
import { ListeningStats, createListeningSync } from '../public/listeningStats.js';

const now = +new Date(2026, 9, 15, 12);
const day = '2026-10-15';
const completionKey = '["song","artist"]';
async function tracker() {
  const stats = new ListeningStats({ userId: 'alice', indexedDB: null });
  await stats.ready();
  stats.rememberTrack({ trackId: 'local-id', sourceId: 'source:123', title: 'Song', artist: 'Artist' });
  stats.records = [{ id: 'record', userId: 'alice', trackId: 'local-id', timestamp: now, durationPlayed: 20 }];
  stats.stats.completedPlayCount['local-id'] = 2;
  stats.stats.coListeningTime.bob = 10;
  return stats;
}
const cloud = () => ({ daily: [{ day, seconds: 30 }], completed: [{ key: 'source:123', completionKey, completed: 3 }],
  coListening: [{ friendId: 'bob', seconds: 40 }, { friendId: 'charlie', seconds: 50 }] });

test('automatic listening sync defers hidden work and coalesces foreground triggers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stats = await tracker();
  let visible = true, requests = 0, release;
  const client = { user: { id: 'alice', isActivated: true }, request: async path => {
    requests++;
    if (path.includes('?')) return new Promise(resolve => { release = resolve; });
    return {};
  } };
  const sync = createListeningSync({ stats, client, listTracks: async () => [], shouldSync: () => visible });
  try {
    stats.notify(); // queue while visible, then hide before it fires
    visible = false; t.mock.timers.tick(60000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 0);
    stats.notify(); t.mock.timers.tick(60000);
    assert.equal(requests, 0);
    visible = true;
    const first = sync.sync();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const duplicate = sync.sync();
    release(cloud()); await Promise.all([first, duplicate]);
    assert.equal(requests, 2, 'one upload and one pull for simultaneous resume events');
    const saved = stats.records[0].durationPlayed;
    stats.records[0].durationPlayed += 5;
    const next = sync.sync();
    await new Promise(resolve => setImmediate(resolve));
    release(cloud()); await next;
    assert.equal(stats.records[0].durationPlayed, saved + 5);
    assert.equal(requests, 4, 'later local changes still upload');
  } finally { sync.stop(); }
});

test('other-device totals merge once while local playback and completion uploads stay local', async () => {
  const stats = await tracker();
  stats.mergeCloud(cloud()); stats.mergeCloud(cloud());
  for (const period of ['week', 'month', 'year']) assert.equal(stats.summary(period, now), 50);
  assert.equal(stats.completedCount('local-id'), 5);
  assert.equal(stats.completedUploads()[0].completed, 2);
  assert.deepEqual(stats.coListeningTotals(), { bob: 50, charlie: 50 });
  stats.sample({ trackId: 'local-id', duration: 10, now, currentTime: 0, playing: true });
  stats.sample({ trackId: 'local-id', duration: 10, now: now + 10000, currentTime: 10, ended: true });
  assert.equal(stats.completedCount('local-id'), 6);
  assert.equal(stats.stats.completedPlayCount['local-id'], 3);
  stats.mergeCloud(null);
  assert.equal(stats.summary('week', now + 10000), 30);
  assert.equal(stats.completedCount('local-id'), 3);
  assert.equal(stats.coListeningSeconds('bob'), 10);
});

test('cloud calendar data respects calendar boundaries and excludes future days', async () => {
  const stats = await tracker();
  stats.mergeCloud({ daily: [{ day: '2026-01-01', seconds: 100 }, { day: '2026-10-01', seconds: 50 },
    { day, seconds: 30 }, { day: '2026-10-16', seconds: 999 }] });
  assert.equal(stats.summary('week', now), 50);
  assert.equal(stats.summary('month', now), 100);
  assert.equal(stats.summary('year', now), 200);
});

test('sync retries failed absolute snapshots, batches at 200, and uploads only changes thereafter', async () => {
  const stats = await tracker(), requests = [];
  stats.records = Array.from({ length: 401 }, (_, i) => ({ ...stats.records[0], id: String(i) }));
  let fail = true, plays = 0;
  const client = { user: { id: 'alice', isActivated: true }, request: async (path, body) => {
    requests.push({ path, body: structuredClone(body) });
    if (fail) throw new Error('offline');
    return cloud();
  } };
  const sync = createListeningSync({ stats, client, listTracks: async () => [], uploadPlays: async () => { plays++; } });
  try {
    stats.mergeCloud(cloud());
    await assert.rejects(sync.sync(), /offline/);
    assert.deepEqual(stats.cloud, cloud());
    fail = false; await sync.sync();
    const uploads = requests.filter(r => r.body);
    assert.deepEqual(uploads.map(r => r.body.records.length), [200, 200, 200, 1]);
    assert.deepEqual(uploads[0].body, uploads[1].body);
    assert.equal(uploads[1].body.records[0].key, 'source:123');
    assert.equal(uploads[1].body.records[0].day, day);
    const length = requests.length;
    await sync.sync();
    assert.equal(requests.length, length + 1); // pull only; already acknowledged snapshots
    stats.records[0].durationPlayed += 5;
    await sync.sync();
    assert.equal(requests.at(-2).body.records.length, 1);
    assert.equal(requests.at(-2).body.records[0].seconds, 25);
    assert.equal(plays, 3);
    client.user.id = 'other-account';
    const before = requests.length;
    await sync.sync(); assert.equal(requests.length, before);
  } finally { sync.stop(); }
});

test('logout during a request prevents applying its cloud snapshot', async () => {
  const stats = await tracker();
  let release;
  const client = { user: { id: 'alice', isActivated: true }, request: async path => {
    if (path.includes('?')) return new Promise(resolve => { release = () => resolve(cloud()); });
    return { ok: true };
  } };
  const sync = createListeningSync({ stats, client, listTracks: async () => [] });
  const running = sync.sync();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  sync.stop(); client.user = null; release(); await running;
  assert.equal(stats.cloud, undefined);
});

test('a completion during an in-flight listening pull queues its changed snapshot', async () => {
  const stats = await tracker(), uploads = [];
  let release, pulls = 0;
  const client = { user: { id: 'alice', isActivated: true }, request: async (path, body) => {
    if (body) { uploads.push(structuredClone(body)); return {}; }
    if (++pulls === 1) return new Promise(resolve => { release = resolve; });
    return cloud();
  } };
  const sync = createListeningSync({ stats, client, listTracks: async () => [] });
  try {
    const first = sync.sync();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    stats.records[0].durationPlayed += 5;
    const completion = sync.sync({ changed: true });
    release(cloud()); await Promise.all([first, completion]);
    assert.deepEqual(uploads.map(body => body.records[0].seconds), [20, 25]);
    assert.equal(pulls, 2);
  } finally { sync.stop(); }
});
