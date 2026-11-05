import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import React from 'react';
import htm from 'htm';
import { toSimplified } from '../public/zhVariants.js';
import { localView, mergePlaylists, toCloudTrack } from '../public/cloudSync.js';

const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function artistKey('), source.indexOf('function RenameTrackSheet('));
function setup(overrides = {}) {
  const item = { id: 'session', localId: 'local', sourceId: 'source', title: 'Old', artist: '周杰伦' };
  const state = { library: [item, { artist: '周杰倫' }, { artist: '周杰倫' }, { artist: 'ADELE' }, { artist: 'adele' }, { artist: 'adele' }], role: null };
  const calls = [], trackMeta = new Map();
  const context = {
    get: () => state, toSimplified,
    listeningStats: { stats: { trackMetadata: { old: { artist: '陈奕迅' }, duplicate: { artist: '周杰伦' } } } },
    account: { playlists: [{ tracks: [{ sourceId: 'source', title: 'Old' }, { artist: '陳奕迅' }, { artist: 'Cloud' }] }] },
    LocalLib: { updateTrack: async (id, patch) => { calls.push(['updateTrack', id, { ...patch }]); return { ...item, id, ...patch }; } },
    session: { patch: (id, patch) => calls.push(['patch', id, { ...patch }]) },
    playlistStore: { list: [{ id: 'p', pending: [{ id: 'source', sourceId: 'source' }] }], replacePending: async (...args) => calls.push(['pending', ...args]) },
    cloudSync: { schedule: () => calls.push(['sync']) }, trackMeta, toCloudTrack, ...overrides,
  };
  const actions = vm.runInNewContext(`${helpers}; ({ existingArtists, artistSuggestions, renameLibraryTrack })`, context);
  return { ...actions, item, state, calls, context, trackMeta };
}

test('artist suggestions group Chinese variants and case and prefer the most frequent library spelling', () => {
  const api = setup();
  assert.deepEqual(Array.from(api.artistSuggestions('周杰伦'), a => a.name), ['周杰倫']);
  assert.deepEqual(Array.from(api.artistSuggestions('AdE'), a => a.name), ['adele']);
  assert.deepEqual(Array.from(api.artistSuggestions('陈'), a => a.name), ['陈奕迅']);
  assert.equal(api.existingArtists().length, 4);
});

test('rename persists canonical metadata, patches the session, updates playlist copies and schedules sync', async () => {
  const api = setup();
  await api.renameLibraryTrack(api.item, ' New title ', ' 周杰伦 ');
  const [save, patch] = api.calls;
  assert.equal(save[0], 'updateTrack'); assert.equal(save[1], 'local');
  assert.equal(save[2].title, 'New title'); assert.equal(save[2].artist, '周杰倫');
  assert.ok(save[2].metadataUpdatedAt > 0);
  assert.deepEqual(patch, ['patch', 'session', save[2]]);
  assert.equal(api.calls[2][0], 'pending'); assert.equal(api.calls.at(-1)[0], 'sync');
  assert.equal(api.trackMeta.get('local').title, 'New title');
  assert.equal(api.context.account.playlists[0].tracks[0].artist, '周杰倫');
  await api.renameLibraryTrack(api.item, 'Another', 'ADELE');
  assert.equal(api.calls.findLast(c => c[0] === 'updateTrack')[2].artist, 'adele');
});

test('blank titles and unauthorized renames do not write; empty artist is allowed', async () => {
  const api = setup();
  await assert.rejects(api.renameLibraryTrack(api.item, '  ', 'artist'), /歌名不能为空/);
  api.state.role = 'guest';
  await assert.rejects(api.renameLibraryTrack(api.item, 'Title', 'artist'));
  api.state.role = null;
  await assert.rejects(api.renameLibraryTrack({ id: 'remote' }, 'Title', 'artist'));
  assert.equal(api.calls.length, 0);
  await api.renameLibraryTrack(api.item, 'Title', ' ');
  assert.equal(api.calls[0][2].artist, '');
});

test('renamed metadata wins the next cloud merge and older devices cannot revert it', () => {
  const playlist = { id: 'p', name: 'List', trackIds: ['local'], createdAt: 1 };
  const track = { id: 'local', sourceId: 'source', title: 'Old', artist: 'Old artist' };
  const cloud = [{ id: 'p', name: 'List', createdAt: 1, updatedAt: 1, tracks: [toCloudTrack(track)] }];
  const renamed = { ...track, title: 'New', artist: '', metadataUpdatedAt: 10 };
  const result = mergePlaylists({ local: [localView(playlist, new Map([['local', renamed]]))], cloud, now: 20 });
  assert.equal(result.cloudChanged, true);
  assert.equal(result.cloud[0].tracks[0].title, 'New');
  assert.equal(result.cloud[0].tracks[0].artist, '');
  assert.equal(result.cloud[0].updatedAt, 20);
  const stale = mergePlaylists({ local: [localView(playlist, new Map([['local', track]]))], cloud: result.cloud, base: result.base, now: 30 });
  assert.equal(stale.cloudChanged, false);
  const server = readFileSync(new URL('../music-service/src/accounts.js', import.meta.url), 'utf8');
  const validate = vm.runInNewContext(`${server.slice(server.indexOf('export function validatePlaylists('), server.indexOf('export function mountAccounts(')).replace('export function', 'function')}; validatePlaylists`, { fail: () => assert.fail('invalid metadata') });
  assert.equal(validate(result.cloud)[0].tracks[0].metadataUpdatedAt, 10);
});

test('rename menu is disabled for guests and tracks without a local ID', () => {
  const code = source.slice(source.indexOf('function TrackMenuSheet('), source.indexOf('function PlaylistSongPicker('));
  for (const [role, localId, disabled] of [['guest', 'local', true], [null, null, true], [null, 'local', false]]) {
    const state = { role, trackMenu: { itemId: 'track', viewId: 'all' }, library: [{ id: 'track', localId, title: 'Song' }], playlists: [] };
    const Component = vm.runInNewContext(`${code}; TrackMenuSheet`, {
      html: htm.bind(React.createElement), useStore: fn => fn(state), useState: () => [false, () => {}], useBackLayer() {}, useEffect() {},
      ALL_ID: 'all', playlistsOf: () => [], cx: (...parts) => parts.join(' '), Cover() {}, Pencil() {}, ListPlus() {}, Trash2() {},
    });
    const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : [];
    const button = flatten(Component()).find(n => n.type === 'button' && String(n.props.children).includes('重命名'));
    assert.equal(button.props.disabled, disabled);
  }
});
