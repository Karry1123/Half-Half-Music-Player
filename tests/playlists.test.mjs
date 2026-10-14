import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_ID,
  INBOX_ID,
  PlaylistStore,
  addTracks,
  createPlaylist,
  deletePlaylist,
  migrate,
  missingFromLibrary,
  normalizeName,
  playlistsOf,
  prune,
  removeTracks,
  renamePlaylist,
  resolveScope,
} from '../public/playlists.js';

const memBackend = (initial = []) => {
  const db = new Map(initial.map((p) => [p.id, structuredClone(p)]));
  return {
    db,
    writes: 0,
    failNext: false,
    async listPlaylists() { return [...db.values()].map((p) => structuredClone(p)); },
    async putPlaylist(p) { if (this.failNext) { this.failNext = false; throw new Error('disk full'); } this.writes++; db.set(p.id, structuredClone(p)); },
    async deletePlaylist(id) { this.writes++; db.delete(id); },
  };
};

test('migrate: first run puts every existing song into the default library (no song is lost)', () => {
  const { list, migrated } = migrate([], ['t1', 't2', 't3'], 100);
  assert.equal(migrated, true);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, INBOX_ID);
  assert.deepEqual(list[0].trackIds, ['t1', 't2', 't3']);
  assert.equal(list[0].system, true);
});

test('migrate: later runs keep stored playlists, inbox first, and repair bad records', () => {
  const stored = [
    { id: 'b', name: 'B', createdAt: 20, trackIds: ['t2', 't2', 5, 't3'] },
    { id: INBOX_ID, name: '默认曲库', createdAt: 1, trackIds: ['t1'], system: true },
    { id: 'a', name: '', createdAt: 10 },
    { id: ALL_ID, name: 'should never be stored' },
    null,
  ];
  const { list, migrated } = migrate(stored, ['t1', 't2', 't3', 't4']);
  assert.equal(migrated, false);
  assert.deepEqual(list.map((p) => p.id), [INBOX_ID, 'a', 'b']);
  assert.deepEqual(list[0].trackIds, ['t1'], 'tracks added later are not silently pushed into the inbox');
  assert.deepEqual(list[2].trackIds, ['t2', 't3'], 'duplicates and non-string ids removed');
  assert.equal(list[1].name, '未命名歌单');
  assert.deepEqual(list[1].trackIds, []);
});

test('names: trimmed, whitespace collapsed, 40 chars max, empty / duplicate rejected', () => {
  assert.equal(normalizeName('  通勤   路上  '), '通勤 路上');
  assert.equal([...normalizeName('长'.repeat(60))].length, 40);
  assert.throws(() => normalizeName('   '), { code: 'EMPTY_NAME' });
  let list = migrate([], []).list;
  list = createPlaylist(list, '跑步', { id: 'p1', now: 1 }).list;
  assert.throws(() => createPlaylist(list, ' 跑步 '), { code: 'DUPLICATE' });
  assert.throws(() => createPlaylist(list, '默认曲库'), { code: 'DUPLICATE' });
  assert.throws(() => createPlaylist(list, '全部已下载 / 已导入'), { code: 'DUPLICATE' });
});

test('system playlist cannot be renamed or deleted; custom ones can', () => {
  let list = migrate([], ['t1']).list;
  list = createPlaylist(list, '夜跑', { id: 'p1' }).list;
  assert.throws(() => renamePlaylist(list, INBOX_ID, 'x'), { code: 'SYSTEM' });
  assert.throws(() => deletePlaylist(list, INBOX_ID), { code: 'SYSTEM' });
  list = renamePlaylist(list, 'p1', '晨跑');
  assert.equal(list.find((p) => p.id === 'p1').name, '晨跑');
  assert.throws(() => renamePlaylist(list, 'nope', 'x'), { code: 'NOT_FOUND' });
  list = deletePlaylist(list, 'p1');
  assert.deepEqual(list.map((p) => p.id), [INBOX_ID]);
});

test('addTracks / removeTracks: no duplicates, order kept, ALL ignored, unknown playlist rejected', () => {
  let list = migrate([], []).list;
  list = createPlaylist(list, 'A', { id: 'a' }).list;
  let r = addTracks(list, ['a', INBOX_ID, ALL_ID], ['t1', 't2', 't1']);
  assert.equal(r.changed.length, 2);
  r = addTracks(r.list, ['a'], ['t2', 't3']);
  assert.deepEqual(r.list.find((p) => p.id === 'a').trackIds, ['t1', 't2', 't3']);
  assert.equal(addTracks(r.list, ['a'], ['t1']).changed.length, 0, 'already there: nothing to write');
  assert.throws(() => addTracks(r.list, ['gone'], ['t1']), { code: 'NOT_FOUND' });
  const rm = removeTracks(r.list, 'a', ['t2']);
  assert.deepEqual(rm.list.find((p) => p.id === 'a').trackIds, ['t1', 't3']);
  assert.deepEqual(rm.list.find((p) => p.id === INBOX_ID).trackIds, ['t1', 't2'], 'other playlists untouched');
  assert.deepEqual(playlistsOf(rm.list, 't2'), [INBOX_ID]);
});

test('deleting a playlist never deletes songs; deleting a song removes it everywhere', () => {
  let list = migrate([], ['t1', 't2']).list;
  list = createPlaylist(list, 'A', { id: 'a' }).list;
  list = addTracks(list, ['a'], ['t1', 't2']).list;
  list = deletePlaylist(list, 'a');
  assert.deepEqual(list[0].trackIds, ['t1', 't2'], 'songs still in the default library');
  list = createPlaylist(list, 'B', { id: 'b' }).list;
  list = addTracks(list, ['b'], ['t2']).list;
  const p = prune(list, new Set(['t1']));
  assert.deepEqual(p.list.map((x) => x.trackIds), [['t1'], []]);
  assert.equal(p.changed.length, 2);
});

test('resolveScope: playlist order, mapped to session ids, missing tracks reported', () => {
  const library = [
    { id: 's1', localId: 't1' },
    { id: 's2', localId: 't2' },
    { id: 's3', localId: null }, // not saved on this device: cannot be in a playlist
  ];
  const pl = { id: 'a', trackIds: ['t2', 't9', 't1'] };
  assert.deepEqual(resolveScope(pl, library), ['s2', 's1']);
  assert.deepEqual(resolveScope(null, library), ['s1', 's2', 's3']);
  assert.deepEqual(resolveScope({ id: ALL_ID }, library), ['s1', 's2', 's3']);
  assert.deepEqual(missingFromLibrary(pl, library), ['t9']);
  assert.deepEqual(missingFromLibrary(null, library), []);
});

test('store: load migrates once and persists the inbox; second load does not re-seed', async () => {
  const be = memBackend();
  const s1 = new PlaylistStore(be);
  const r1 = await s1.load(['t1', 't2']);
  assert.deepEqual(r1, { migrated: true, count: 1 });
  assert.deepEqual(be.db.get(INBOX_ID).trackIds, ['t1', 't2']);
  const s2 = new PlaylistStore(be);
  const r2 = await s2.load(['t1', 't2', 't3']);
  assert.equal(r2.migrated, false);
  assert.deepEqual(s2.get(INBOX_ID).trackIds, ['t1', 't2']);
});

test('store: load prunes references to songs that were deleted while the app was closed', async () => {
  const be = memBackend([{ id: INBOX_ID, name: '默认曲库', trackIds: ['t1', 'gone'], system: true }, { id: 'a', name: 'A', trackIds: ['gone'] }]);
  const s = new PlaylistStore(be);
  await s.load(['t1']);
  assert.deepEqual(be.db.get(INBOX_ID).trackIds, ['t1']);
  assert.deepEqual(be.db.get('a').trackIds, []);
});

test('store: create / add / rename / remove are persisted and notify subscribers', async () => {
  const be = memBackend();
  const s = new PlaylistStore(be);
  await s.load([]);
  const seen = [];
  s.subscribe((list) => seen.push(list.length));
  const p = await s.create('通勤');
  assert.equal(be.db.get(p.id).name, '通勤');
  assert.equal(await s.addTracks([p.id], ['t1', 't2']), 1);
  assert.deepEqual(be.db.get(p.id).trackIds, ['t1', 't2']);
  await s.rename(p.id, '下班路上');
  assert.equal(be.db.get(p.id).name, '下班路上');
  await s.removeTracks(p.id, ['t1']);
  assert.deepEqual(be.db.get(p.id).trackIds, ['t2']);
  await s.remove(p.id);
  assert.equal(be.db.has(p.id), false);
  assert.ok(seen.length >= 5);
  await assert.rejects(s.remove(INBOX_ID), { code: 'SYSTEM' });
});

test('store: a failed write rolls the in-memory state back', async () => {
  const be = memBackend();
  const s = new PlaylistStore(be);
  await s.load([]);
  be.failNext = true;
  await assert.rejects(s.create('会失败'), /disk full/);
  assert.equal(s.list.length, 1, 'only the inbox is left');
  assert.equal(be.db.size, 1);
});

test('store: concurrent writes are serialized (no lost updates)', async () => {
  const be = memBackend();
  const s = new PlaylistStore(be);
  await s.load([]);
  await Promise.all(['t1', 't2', 't3', 't4'].map((t) => s.addTracks([INBOX_ID], [t])));
  assert.deepEqual(be.db.get(INBOX_ID).trackIds, ['t1', 't2', 't3', 't4']);
});
