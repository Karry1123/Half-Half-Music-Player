import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_ID,
  FAVORITES_ID,
  PlaylistStore,
  addTracks,
  createPlaylist,
  deletePlaylist,
  migrate,
  migrateInbox,
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

test('normalize creates empty favorites first and converts partial inbox once', () => {
  const { list, migrated } = migrate([{ id: 'inbox', trackIds: ['t1'], system: true }], ['t1', 't2'], 100);
  assert.equal(migrated, true);
  assert.equal(list[0].id, FAVORITES_ID);
  assert.equal(list[0].name, '我喜欢的音乐');
  assert.deepEqual(list[0].trackIds, []);
  const legacy = list.find(p => p.id === 'pl-legacy-inbox');
  assert.equal(legacy.name, '默认曲库');
  assert.deepEqual(legacy.trackIds, ['t1']);
  assert.equal(legacy.system, false);
  assert.doesNotThrow(() => renamePlaylist(list, legacy.id, '旧歌单'));
  assert.doesNotThrow(() => deletePlaylist(list, legacy.id));
  assert.equal(migrate(list, ['t1', 't2']).migrated, false);
});
test('legacy inbox equal to library is dropped regardless of order or duplicates', () => {
  assert.deepEqual(migrate([{ id: 'inbox', trackIds: ['t2', 't1', 't1'] }], ['t1', 't2']).list.map(p => p.id), [FAVORITES_ID]);
});

test('names: trimmed, whitespace collapsed, 40 chars max, empty / duplicate rejected', () => {
  assert.equal(normalizeName('  通勤   路上  '), '通勤 路上');
  assert.equal([...normalizeName('长'.repeat(60))].length, 40);
  assert.throws(() => normalizeName('   '), { code: 'EMPTY_NAME' });
  let list = migrate([], []).list;
  list = createPlaylist(list, '跑步', { id: 'p1', now: 1 }).list;
  assert.throws(() => createPlaylist(list, ' 跑步 '), { code: 'DUPLICATE' });
  assert.throws(() => createPlaylist(list, '我喜欢的音乐'), { code: 'DUPLICATE' });
  assert.throws(() => createPlaylist(list, '全部已下载 / 已导入'), { code: 'DUPLICATE' });
});

test('system playlist cannot be renamed or deleted; custom ones can', () => {
  let list = migrate([], ['t1']).list;
  list = createPlaylist(list, '夜跑', { id: 'p1' }).list;
  assert.throws(() => renamePlaylist(list, FAVORITES_ID, 'x'), { code: 'SYSTEM' });
  assert.throws(() => deletePlaylist(list, FAVORITES_ID), { code: 'SYSTEM' });
  list = renamePlaylist(list, 'p1', '晨跑');
  assert.equal(list.find((p) => p.id === 'p1').name, '晨跑');
  assert.throws(() => renamePlaylist(list, 'nope', 'x'), { code: 'NOT_FOUND' });
  list = deletePlaylist(list, 'p1');
  assert.deepEqual(list.map((p) => p.id), [FAVORITES_ID]);
});

test('addTracks / removeTracks: no duplicates, order kept, ALL ignored, unknown playlist rejected', () => {
  let list = migrate([], []).list;
  list = createPlaylist(list, 'A', { id: 'a' }).list;
  let r = addTracks(list, ['a', FAVORITES_ID, ALL_ID], ['t1', 't2', 't1']);
  assert.equal(r.changed.length, 2);
  r = addTracks(r.list, ['a'], ['t2', 't3']);
  assert.deepEqual(r.list.find((p) => p.id === 'a').trackIds, ['t1', 't2', 't3']);
  assert.equal(addTracks(r.list, ['a'], ['t1']).changed.length, 0, 'already there: nothing to write');
  assert.throws(() => addTracks(r.list, ['gone'], ['t1']), { code: 'NOT_FOUND' });
  const rm = removeTracks(r.list, 'a', ['t2']);
  assert.deepEqual(rm.list.find((p) => p.id === 'a').trackIds, ['t1', 't3']);
  assert.deepEqual(rm.list.find((p) => p.id === FAVORITES_ID).trackIds, ['t1', 't2'], 'other playlists untouched');
  assert.deepEqual(playlistsOf(rm.list, 't2'), [FAVORITES_ID]);
});

test('deleting a playlist never deletes songs; deleting a song removes it everywhere', () => {
  let list = addTracks(migrate([], ['t1', 't2']).list, [FAVORITES_ID], ['t1', 't2']).list;
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

test('store: load migrates once and persists empty favorites; second load does not re-seed', async () => {
  const be = memBackend();
  const s1 = new PlaylistStore(be);
  const r1 = await s1.load(['t1', 't2']);
  assert.deepEqual(r1, { migrated: true, count: 1 });
  assert.deepEqual(be.db.get(FAVORITES_ID).trackIds, []);
  const s2 = new PlaylistStore(be);
  const r2 = await s2.load(['t1', 't2', 't3']);
  assert.equal(r2.migrated, false);
  assert.deepEqual(s2.get(FAVORITES_ID).trackIds, []);
});

test('store: load prunes references to songs that were deleted while the app was closed', async () => {
  const be = memBackend([{ id: FAVORITES_ID, name: '我喜欢的音乐', trackIds: ['t1', 'gone'], system: true }, { id: 'a', name: 'A', trackIds: ['gone'] }]);
  const s = new PlaylistStore(be);
  await s.load(['t1']);
  assert.deepEqual(be.db.get(FAVORITES_ID).trackIds, ['t1']);
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
  await assert.rejects(s.remove(FAVORITES_ID), { code: 'SYSTEM' });
});

test('store: a failed write rolls the in-memory state back', async () => {
  const be = memBackend();
  const s = new PlaylistStore(be);
  await s.load([]);
  be.failNext = true;
  await assert.rejects(s.create('会失败'), /disk full/);
  assert.equal(s.list.length, 1, 'only favorites is left');
  assert.equal(be.db.size, 1);
});

test('store: concurrent writes are serialized (no lost updates)', async () => {
  const be = memBackend();
  const s = new PlaylistStore(be);
  await s.load([]);
  await Promise.all(['t1', 't2', 't3', 't4'].map((t) => s.addTracks([FAVORITES_ID], [t])));
  assert.deepEqual(be.db.get(FAVORITES_ID).trackIds, ['t1', 't2', 't3', 't4']);
});


test('public playlist copies are private new playlists with pending songs and distinct names', async () => {
  const be = memBackend();
  const store = new PlaylistStore(be, { now: () => 42 });
  await store.load([]);
  const original = { id: 'friend-list', name: 'Night songs', isPublic: true, coverUrl: 'https://example.com/list.jpg', tracks: [
    { title: 'Song', artist: 'Artist', sourceId: 'bilibili:BV123', cover: 'https://example.com/song.jpg', duration: 180 },
    { title: 'Song', artist: 'Artist', sourceId: '', duration: 200 },
  ] };
  const copy = await store.copyPublic(original);
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.isPublic, false);
  assert.deepEqual(copy.trackIds, []);
  assert.equal(copy.pending[0].id, 'bilibili:BV123');
  assert.equal(copy.pending[0].cover, original.tracks[0].cover);
  assert.match(copy.pending[1].id, /^search:/);
  assert.equal(copy.pending[1].sourceId, '');
  assert.equal(copy.coverUrl, original.coverUrl);
  assert.deepEqual(be.db.get(copy.id), copy);
  const second = await store.copyPublic(original);
  assert.notEqual(second.name, copy.name);
  assert.notEqual(second.id, copy.id);
  await store.setPublic(copy.id, true);
  assert.equal(be.db.get(copy.id).isPublic, true);
  await store.applyRemote({ upserts: [{ id: copy.id, name: copy.name, isPublic: false, coverUrl: copy.coverUrl, trackIds: [], pending: copy.pending }] });
  assert.equal(store.get(copy.id).isPublic, false);
  assert.equal(store.get(copy.id).coverUrl, original.coverUrl);
});

test('existing and newly created playlists default to private', () => {
  const { list } = migrate([{ id: 'old', name: 'Old playlist', trackIds: [] }], []);
  assert.equal(list.find(p => p.id === 'old').isPublic, false);
  assert.equal(list[0].isPublic, false);
  assert.equal(createPlaylist(list, 'new playlist').playlist.isPublic, false);
});

test('cloud merge preserves favorites system name and flag and ignores deletion', async () => {
 const store = new PlaylistStore(memBackend()); await store.load([]);
 await store.applyRemote({ upserts: [{ id: FAVORITES_ID, name: 'wrong', system: false, trackIds: ['t1'] }], deletes: [FAVORITES_ID] });
 assert.equal(store.get(FAVORITES_ID).system, true);
 assert.equal(store.get(FAVORITES_ID).name, '我喜欢的音乐');
 assert.deepEqual(store.get(FAVORITES_ID).trackIds, ['t1']);
});

test('migration helper and persisted conversion do not resurrect or re-seed the legacy inbox', async () => {
  const inbox = { id: 'inbox', name: 'old', trackIds: ['a'], system: true };
  assert.deepEqual(migrateInbox(inbox, ['a', 'b']).trackIds, ['a']);
  assert.equal(migrateInbox(inbox, ['a']), null);
  for (const library of [['a'], ['a', 'b']]) {
    const backend = memBackend([inbox]);
    const store = new PlaylistStore(backend);
    await store.load(library);
    assert.equal(backend.db.has('inbox'), false);
    assert.equal(store.list.length, library.length === 1 ? 1 : 2);
    const again = new PlaylistStore(backend);
    assert.equal((await again.load([...library, 'c'])).migrated, false);
    assert.deepEqual(again.get(FAVORITES_ID).trackIds, []);
  }
});

test('empty legacy inbox is dropped even when the library contains tracks', async () => {
  for (const trackIds of [[], undefined, ['', 5]]) {
    const inbox = { id: 'inbox', name: '默认曲库', trackIds, system: true };
    assert.equal(migrateInbox(inbox, ['a']), null);
    assert.deepEqual(migrate([inbox], ['a']).list.map(p => p.id), [FAVORITES_ID]);
    const backend = memBackend([inbox]), store = new PlaylistStore(backend);
    await store.load(['a']);
    assert.equal(backend.db.has('inbox'), false);
    assert.deepEqual(store.list.map(p => p.id), [FAVORITES_ID]);
  }
});

test('previously converted empty default artifact is removed from storage without deleting custom empty playlists', async () => {
  const artifact = { id: 'pl-legacy-inbox', name: '默认曲库', trackIds: [] };
  const custom = { id: 'custom', name: '默认曲库', trackIds: [] };
  const backend = memBackend([artifact, custom]), store = new PlaylistStore(backend);
  await store.load(['a']);
  assert.equal(backend.db.has(artifact.id), false);
  assert.equal(backend.db.has(custom.id), true);
  for (const kept of [{ ...artifact, name: '已改名' }, { ...artifact, pending: [{ id: 'cloud-song' }] }]) {
    assert.equal(migrateInbox(kept, ['a']), kept);
  }
});
