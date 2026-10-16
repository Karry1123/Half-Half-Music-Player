import test from 'node:test';
import assert from 'node:assert/strict';
import { ListeningStats, createCompletedPlayUploader } from '../public/listeningStats.js';

const base = new Date(2026, 9, 15, 12).getTime();
async function tracker(options = {}) {
  const stats = new ListeningStats({ userId: 'alice', indexedDB: null, ...options });
  await stats.ready();
  const sample = (seconds, position = seconds, extras = {}) => stats.sample({
    trackId: 'song', duration: 100, currentTime: position, now: base + seconds * 1000,
    playing: true, connected: true, friendId: 'bob', ...extras,
  });
  return { stats, sample };
}

test('counts real advancing playback, excludes pauses and buffering, and scopes co-listening to connection', async () => {
  const { stats, sample } = await tracker();
  sample(0); sample(10); sample(20, 20, { playing: false });
  sample(40, 20, { playing: true, connected: false });
  sample(50, 30, { connected: false });
  sample(60, 30, { connected: true }); // buffer, then reconnect
  sample(70, 40);
  assert.equal(stats.summary('week', base + 70000), 40);
  assert.equal(stats.coListeningSeconds('bob'), 30);
  assert.equal(stats.completedCount('song'), 0);
});

test('forward seeking and seeking directly to ended never grant skipped time or a completion', async () => {
  const { stats, sample } = await tracker();
  sample(0); sample(5); sample(6, 90, { seeking: true });
  sample(7, 90); sample(17, 100, { ended: true, playing: false });
  assert.equal(stats.summary('week', base + 17000), 15);
  assert.equal(stats.completedCount('song'), 0);
  const other = await tracker();
  other.sample(0); other.sample(1, 100, { ended: true, playing: false });
  assert.equal(other.stats.completedCount('song'), 0);
  assert.equal(other.stats.summary('week', base + 1000), 0);
});

test('95% actual playback completes exactly once; replay may complete again', async () => {
  const { stats, sample } = await tracker();
  sample(0); sample(95); sample(100, 100, { ended: true, playing: false });
  sample(101, 100, { ended: true, playing: false });
  assert.equal(stats.completedCount('song'), 1);
  sample(102, 0); sample(197, 95); sample(202, 100, { ended: true, playing: false });
  assert.equal(stats.completedCount('song'), 2);
  assert.equal(stats.summary('week', base + 202000), 200);
});

test('natural end completes unknown-duration playback, but starting near end does not', async () => {
  const { stats, sample } = await tracker();
  sample(0, 0, { duration: 0 }); sample(8, 8, { duration: 0, ended: true, playing: false });
  assert.equal(stats.completedCount('song'), 1);
  const other = await tracker();
  other.sample(0, 95); other.sample(5, 100, { ended: true, playing: false });
  assert.equal(other.stats.completedCount('song'), 0);
});

test('track switches reset completion accounting and cannot attribute position jumps as listening', async () => {
  const { stats, sample } = await tracker();
  sample(0); sample(50); sample(51, 0, { trackId: 'next' }); sample(101, 50, { trackId: 'next' });
  assert.equal(stats.completedCount('song'), 0);
  assert.equal(stats.completedCount('next'), 0);
  assert.equal(stats.summary('week', base + 101000), 100);
});

test('persists records and aggregates per account, hydrates before queued samples', async () => {
  const users = new Map();
  const persistence = {
    async load(userId) { return structuredClone(users.get(userId)); },
    async save(snapshot) {
      const old = users.get(snapshot.userId)?.records || [];
      const merged = new Map(old.map(record => [record.id, record]));
      snapshot.records.forEach(record => merged.set(record.id, record));
      users.set(snapshot.userId, structuredClone({ ...snapshot, records: [...merged.values()] }));
    },
  };
  const { stats, sample } = await tracker({ persistence });
  sample(0); sample(95); await stats.flush(); sample(100); await stats.flush();
  const restored = new ListeningStats({ userId: 'alice', indexedDB: null, persistence });
  restored.sample({ trackId: 'new', duration: 100, currentTime: 0, now: base + 200000, playing: true });
  restored.sample({ trackId: 'new', duration: 100, currentTime: 5, now: base + 205000, playing: true });
  await restored.ready();
  assert.equal(restored.summary('week', base + 205000), 105);
  assert.equal(restored.completedCount('song'), 1);
  assert.equal(restored.coListeningSeconds('bob'), 100);
  assert.equal(restored.records[0].userId, 'alice');
  const stranger = await tracker({ userId: 'charlie', persistence });
  assert.equal(stranger.stats.summary('year', base + 205000), 0);
  assert.equal(stranger.stats.completedCount('song'), 0);
  await restored.flush();
});

test('calendar summaries use this week, month and year, excluding future records', async () => {
  const records = [
    [new Date(2025, 11, 31), 1000], [new Date(2026, 0, 1), 100],
    [new Date(2026, 9, 1), 20], [new Date(2026, 9, 12), 3],
    [new Date(2026, 9, 16), 999],
  ].map(([timestamp, durationPlayed], index) => ({ id: index, userId: 'alice', trackId: 'song', timestamp: +timestamp, durationPlayed }));
  const { stats } = await tracker({ persistence: { load: async () => ({ records }) } });
  assert.equal(stats.summary('week', base), 3);
  assert.equal(stats.summary('month', base), 23);
  assert.equal(stats.summary('year', base), 123);
});

test('failed persistence retains dirty records and can retry without blocking tracking', async () => {
  let failures = true, saved;
  const { stats, sample } = await tracker({ persistence: {
    load: async () => null,
    save: async snapshot => { if (failures) throw new Error('offline storage'); saved = snapshot; },
  } });
  sample(0); sample(10);
  await assert.rejects(stats.flush(), /offline storage/);
  failures = false;
  sample(20); await stats.flush();
  assert.equal(saved.records[0].durationPlayed, 20);
});

test('real playback crossing a month boundary is split into each calendar day', async () => {
  const { stats } = await tracker();
  const midnight = +new Date(2026, 10, 1);
  stats.sample({ trackId: 'song', duration: 100, currentTime: 0, playing: true, now: midnight - 5000 });
  stats.sample({ trackId: 'song', duration: 100, currentTime: 10, playing: true, now: midnight + 5000 });
  assert.equal(stats.summary('month', midnight + 5000), 5);
  assert.equal(stats.summary('year', midnight + 5000), 10);
});

test('playback speed measures wall time and natural completion without treating speed as a seek', async () => {
  const { stats, sample } = await tracker();
  sample(0, 0, { playbackRate: 2 });
  sample(50, 100, { playbackRate: 2, ended: true, playing: false });
  assert.equal(stats.summary('week', base + 50000), 50);
  assert.equal(stats.completedCount('song'), 1);
});

test('startup backfills saved completed totals and preserves device identity across reloads', async () => {
  let saved = { stats: { completedPlayCount: { song: 3 }, trackMetadata: {} } };
  const persistence = { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } };
  const stats = new ListeningStats({ userId: 'alice', persistence });
  const requests = [];
  const client = { user: { isActivated: true }, request: async (path, body) => requests.push({ path, ...structuredClone(body) }) };
  const upload = createCompletedPlayUploader({ stats, client, listTracks: async () => [{ id: 'song', title: '光年之外' }] });
  await upload();
  assert.equal(requests[0].path, '/account/plays');
  assert.deepEqual(requests[0].plays, [{ title: '光年之外', artist: '', cover: '', completed: 3 }]);
  const restored = new ListeningStats({ userId: 'alice', persistence });
  await restored.ready();
  assert.equal(restored.stats.deviceId, requests[0].deviceId);
  await restored.flush();
  await upload();
  assert.deepEqual(requests[1], requests[0], 'retries send absolute totals, never increments');
});

test('each completion uploads immediately and queues totals completed during an upload', async () => {
  const { stats, sample } = await tracker();
  const requests = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const upload = createCompletedPlayUploader({ stats,
    client: { user: { isActivated: true }, request: async (_, body) => { requests.push(structuredClone(body)); if (requests.length === 1) await blocked; } },
    listTracks: async () => [{ id: 'song', title: '成都', artist: '赵雷' }],
  });
  const unsubscribe = stats.subscribeCompleted(upload);
  sample(0); sample(95);
  // Wait for the first snapshot to reach the simulated network.
  while (!requests.length) await new Promise(resolve => setImmediate(resolve));
  sample(100, 100, { ended: true, playing: false });
  sample(101, 0); sample(196, 95);
  release();
  await upload();
  assert.deepEqual(requests.map(body => body.plays[0].completed), [1, 2]);
  assert.equal(requests[0].deviceId, requests[1].deviceId);
  unsubscribe();
});

test('failed play upload can retry the same cumulative totals', async () => {
  const { stats, sample } = await tracker();
  sample(0); sample(95);
  let fails = true, body;
  const upload = createCompletedPlayUploader({ stats, listTracks: async () => [{ id: 'song', title: '再見', artist: '鄧紫棋' }],
    client: { user: { isActivated: true }, request: async (_, value) => { if (fails) throw new Error('offline'); body = value; } } });
  await assert.rejects(upload(), /offline/);
  fails = false;
  await upload();
  assert.equal(body.plays[0].completed, 1);
});
