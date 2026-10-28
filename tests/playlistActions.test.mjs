import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import React from 'react';
import htm from 'htm';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('downloaded duplicate files retain a playlist action through the download item ID', () => {
  const item = { id: 'local-song', sourceId: 'older-source' };
  const state = { library: [item], downloads: { result: { status: 'done', itemId: item.id } }, role: null };
  const Component = vm.runInNewContext(`${between('function SearchDownloadActions(', '\nfunction ResultCard(')}; SearchDownloadActions`, {
    useStore: fn => fn(state), html: htm.bind(React.createElement), session: { scopeIds: () => [item.id] },
  });
  const markup = renderToStaticMarkup(React.createElement(Component, { r: { id: 'result' } }));
  assert.match(markup, /已在当前队列/);
  assert.match(markup, /加入歌单/);
  assert.doesNotMatch(markup, /重试下载/);
});

test('the shared track action preselects membership and adds only newly selected playlists', async () => {
  const item = { id: 'song', localId: 'saved' }, calls = [];
  const action = vm.runInNewContext(`${between('async function addTrackToPlaylists(', '/** 搜索结果 / 链接解析结果的')}; addTrackToPlaylists`, {
    get: () => ({ playlists: [] }), playlistsOf: () => ['existing'],
    askPlaylists: async request => { assert.equal(request.mode, 'add'); assert.deepEqual([...request.preselect], ['existing']); return ['existing', 'new', 'another']; },
    addItemsToPlaylists: async (targets, tracks) => calls.push([[...targets], [...tracks]]),
  });
  await action(item);
  assert.deepEqual(calls, [[['new', 'another'], ['song']]]);
});

test('cancelling the shared playlist picker does not mutate playlists', async () => {
  const action = vm.runInNewContext(`${between('async function addTrackToPlaylists(', '/** 搜索结果 / 链接解析结果的')}; addTrackToPlaylists`, {
    get: () => ({ playlists: [] }), askPlaylists: async () => null,
    addItemsToPlaylists: () => assert.fail('cancel must not add tracks'),
  });
  await action({ id: 'song' });
});

test('playlist detail picker excludes members and confirms selected library tracks through the shared mutation', async () => {
  const state = { addSongsPlaylistId: 'playlist', playlists: [{ id: 'playlist', name: 'My list', trackIds: ['saved-a'] }],
    library: [{ id: 'a', localId: 'saved-a', title: 'Already added' }, { id: 'b', localId: 'saved-b', title: 'New song' }] };
  const mutations = [], updates = [];
  const hooks = ['', new Set(['b']), false];
  const Component = vm.runInNewContext(`${between('function PlaylistSongPicker(', '/** "放到哪个歌单"')}; PlaylistSongPicker`, {
    useStore: fn => fn(state), useState: () => [hooks.shift(), () => {}], useEffect() {}, useBackLayer() {},
    html: htm.bind(React.createElement), X: () => null, Cover: () => null,
    set: patch => updates.push(patch),
    addItemsToPlaylists: async (targets, ids) => { mutations.push([[...targets], [...ids]]); return ids.length; },
  });
  const tree = Component();
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : [];
  const nodes = flatten(tree);
  assert.equal(nodes.filter(node => node.type === 'input' && node.props.type === 'checkbox').length, 1);
  const confirm = nodes.find(node => node.type === 'button' && String(node.props.children).includes('确认'));
  await confirm.props.onClick();
  assert.deepEqual(mutations, [[['playlist'], ['b']]]);
  assert.equal(updates.at(-1).addSongsPlaylistId, null);
});
