import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudSync, localView, mergeKeys, mergePlaylists } from '../public/cloudSync.js';
import { INBOX_ID, PlaylistStore } from '../public/playlists.js';

const ct = (id, title = id) => ({ id, title, artist: '', sourceId: id, pageUrl: '', hash: '', duration: 0 });
const view = (id, name, keys, extra = {}) => ({ id, name, createdAt: 1, keys, tracks: new Map(keys.map((k) => [k, ct(k)])), ...extra });
const cloudPl = (id, name, keys) => ({ id, name, createdAt: 1, updatedAt: 1, tracks: keys.map((k) => ct(k)) });
const keysOf = (p) => p.tracks.map((t) => t.id);

test('mergeKeys: removals and additions from both sides survive', () => {
  assert.deepEqual(mergeKeys(['a', 'b'], ['a'], ['a', 'b', 'c']), ['a', 'c']); // this device removed b, other added c
  assert.deepEqual(mergeKeys([], ['x', 'a'], ['a', 'b']), ['a', 'b', 'x']); // first sync: union
  assert.deepEqual(mergeKeys(['a', 'b'], ['a', 'b'], ['b']), ['b']); // removed elsewhere
});

test('first sync unions the default library of two devices instead of overwriting', () => {
  const r = mergePlaylists({ local: [view(INBOX_ID, '默认曲库', ['b'])], cloud: [cloudPl(INBOX_ID, '默认曲库', ['a'])], base: {}, now: 5 });
  assert.deepEqual(keysOf(r.cloud[0]), ['a', 'b']);
  assert.equal(r.cloudChanged, true);
  assert.deepEqual(r.upserts[0].keys, ['a', 'b']);
});

test('a song added on one device appears on the other; unchanged sync is a no-op', () => {
  const base = { p1: { name: '通勤', keys: ['a'] } };
  const phone = mergePlaylists({ local: [view('p1', '通勤', ['a', 'b'])], cloud: [cloudPl('p1', '通勤', ['a'])], base, now: 5 });
  assert.deepEqual(keysOf(phone.cloud[0]), ['a', 'b']);
  const web = mergePlaylists({ local: [view('p1', '通勤', ['a'])], cloud: phone.cloud, base, now: 6 });
  assert.equal(web.cloudChanged, false);
  assert.deepEqual(web.upserts.map((u) => u.keys), [['a', 'b']]);
  const again = mergePlaylists({ local: [view('p1', '通勤', ['a', 'b'])], cloud: web.cloud, base: web.base, now: 7 });
  assert.equal(again.cloudChanged, false);
  assert.equal(again.upserts.length, 0);
});

test('deleting a playlist propagates, but not over edits made elsewhere', () => {
  const base = { p1: { name: '旧歌单', keys: ['a'] } };
  const deleted = mergePlaylists({ local: [], cloud: [cloudPl('p1', '旧歌单', ['a'])], base, now: 10 });
  assert.deepEqual(deleted.cloud, [{ id: 'p1', deleted: true, updatedAt: 10 }]);
  const other = mergePlaylists({ local: [view('p1', '旧歌单', ['a'])], cloud: deleted.cloud, base, now: 11 });
  assert.deepEqual(other.deletes, ['p1']);
  const edited = mergePlaylists({ local: [view('p1', '旧歌单', ['a', 'z'])], cloud: deleted.cloud, base, now: 12 });
  assert.deepEqual(edited.deletes, []);
  assert.deepEqual(keysOf(edited.cloud[0]), ['a', 'z']);
  const cloudEdited = mergePlaylists({ local: [], cloud: [cloudPl('p1', '旧歌单', ['a', 'n'])], base, now: 13 });
  assert.deepEqual(cloudEdited.upserts.map((u) => u.id), ['p1'], 'cloud changed since the local delete: keep it');
});

test('same-name playlists created separately on two devices become one; legacy cached copies fold back', () => {
  const r = mergePlaylists({ local: [view('pl-local', '通勤', ['b'])], cloud: [cloudPl('pl-cloud', '通勤', ['a'])], base: {}, now: 5 });
  assert.deepEqual(r.deletes, ['pl-local']);
  assert.deepEqual(r.cloud.map((p) => [p.id, keysOf(p)]), [['pl-cloud', ['a', 'b']]]);
  const legacy = mergePlaylists({ local: [view('cloud-u1-pl-cloud', '通勤', ['a'])], cloud: [cloudPl('pl-cloud', '通勤', ['a', 'c'])], base: {}, legacyPrefix: 'cloud-u1-', now: 5 });
  assert.deepEqual(legacy.deletes, ['cloud-u1-pl-cloud']);
  assert.deepEqual(legacy.upserts.map((u) => [u.id, u.keys]), [['pl-cloud', ['a', 'c']]]);
});

test('localView lists downloaded songs then not-yet-downloaded ones without duplicates', () => {
  const tracks = new Map([['t1', { id: 't1', sourceId: 'bilibili:A', title: 'A' }]]);
  const v = localView({ id: 'p', name: 'p', trackIds: ['t1'], pending: [ct('bilibili:A'), ct('bilibili:B')] }, tracks);
  assert.deepEqual(v.keys, ['bilibili:A', 'bilibili:B']);
});

// ── two devices, one server ──────────────────────────────────────────────────
function fakeServer() {
  const db = { revision: 0, playlists: [] };
  return {
    db,
    client: (user) => ({
      required: true,
      user,
      revision: 0,
      async pull() { this.revision = db.revision; return structuredClone(db.playlists); },
      async push(playlists) {
        if (this.revision !== db.revision) throw Object.assign(new Error('conflict'), { status: 409 });
        db.playlists = structuredClone(playlists);
        this.revision = ++db.revision;
      },
    }),
  };
}
function device(server, tracks) {
  const rows = new Map();
  const store = new PlaylistStore({ listPlaylists: async () => [...rows.values()], putPlaylist: async (p) => rows.set(p.id, structuredClone(p)), deletePlaylist: async (id) => rows.delete(id) });
  let base = null;
  const sync = new CloudSync({ client: server.client({ id: 'u1', isActivated: true }), store, listTracks: async () => tracks, loadBase: async () => base, saveBase: async (_u, b) => { base = b; } });
  return { store, sync, tracks };
}

test('phone adds a song to a playlist → web sees it as not downloaded → downloads it → becomes playable', async () => {
  const server = fakeServer();
  const phone = device(server, [{ id: 'ph1', sourceId: 'bilibili:BV1', hash: 'h1', title: '晴天', artist: '周杰伦' }]);
  const web = device(server, []);
  await phone.store.load(['ph1']);
  await web.store.load([]);
  const p = await phone.store.create('通勤');
  await phone.store.setPublic(p.id, true);
  await phone.store.addTracks([p.id], ['ph1']);
  await phone.sync.sync();
  await web.sync.sync();
  const onWeb = web.store.get(p.id);
  assert.equal(onWeb.name, '通勤');
  assert.equal(onWeb.isPublic, true);
  assert.deepEqual(onWeb.trackIds, []);
  assert.deepEqual(onWeb.pending.map((t) => [t.id, t.title]), [['bilibili:BV1', '晴天']]);
  assert.deepEqual(web.store.get(INBOX_ID).pending.map((t) => t.id), ['bilibili:BV1'], 'default library is shared too');
  await phone.store.setPublic(p.id, false);
  await phone.sync.sync();
  await web.sync.sync();
  assert.equal(web.store.get(p.id).isPublic, false);

  web.tracks.push({ id: 'w1', sourceId: 'bilibili:BV1', hash: 'other-encode', title: '晴天' }); // web downloads it
  await web.sync.sync();
  assert.deepEqual(web.store.get(p.id).trackIds, ['w1']);
  assert.deepEqual(web.store.get(p.id).pending, []);

  // web deletes the file to free space: the song stays in the playlist (not downloaded), nothing changes for the phone
  web.tracks.length = 0;
  await web.store.prune(new Set(), (id) => (id === 'w1' ? ct('bilibili:BV1', '晴天') : null));
  await web.sync.sync();
  await phone.sync.sync();
  assert.deepEqual(phone.store.get(p.id).trackIds, ['ph1']);
  assert.deepEqual(web.store.get(p.id).pending.map((t) => t.id), ['bilibili:BV1']);

  // removing it from the playlist on the web removes it on the phone too
  await web.store.removePending(p.id, 'bilibili:BV1');
  await web.sync.sync();
  await phone.sync.sync();
  assert.deepEqual(phone.store.get(p.id).trackIds, []);
});


test('public visibility and covers survive three-way merge, including remote true to false', () => {
  const tracks = new Map([['t', { id: 't', sourceId: 'song', title: 'Song', cover: 'https://example.com/song.jpg' }]]);
  const local = localView({ id: 'p', name: 'Playlist', isPublic: true, coverUrl: 'https://example.com/list.jpg', trackIds: ['t'] }, tracks);
  const first = mergePlaylists({ local: [local], cloud: [], now: 1 });
  assert.equal(first.cloud[0].isPublic, true);
  assert.equal(first.base.p.isPublic, true);
  assert.equal(first.cloud[0].coverUrl, 'https://example.com/list.jpg');
  assert.equal(first.cloud[0].tracks[0].cover, 'https://example.com/song.jpg');
  const remote = structuredClone(first.cloud);
  remote[0].isPublic = false;
  const pull = mergePlaylists({ local: [local], cloud: remote, base: first.base, now: 2 });
  assert.equal(pull.cloud[0].isPublic, false);
  assert.equal(pull.upserts[0].isPublic, false);
  assert.equal(pull.base.p.isPublic, false);
  assert.equal(pull.upserts[0].coverUrl, 'https://example.com/list.jpg');
  const localEdit = mergePlaylists({ local: [{ ...local, isPublic: false }], cloud: first.cloud, base: first.base, now: 2 });
  assert.equal(localEdit.cloud[0].isPublic, false);
});

test('visibility edits keep a playlist when the other device deletes it', () => {
  const base = { p: { name: 'Playlist', keys: [], isPublic: false } };
  const result = mergePlaylists({ local: [view('p', 'Playlist', [], { isPublic: true })], cloud: [{ id: 'p', deleted: true, updatedAt: 5 }], base, now: 6 });
  assert.deepEqual(result.deletes, []);
  assert.equal(result.cloud[0].isPublic, true);
  const remoteEdit = mergePlaylists({ local: [], cloud: [{ ...cloudPl('p', 'Playlist', []), isPublic: true }], base, now: 6 });
  assert.equal(remoteEdit.upserts[0].isPublic, true);
});
