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
    FAVORITES_ID: 'favorites', get: () => ({ playlists: [] }), playlistsOf: () => ['existing'],
    askPlaylists: async request => { assert.equal(request.mode, 'add'); assert.deepEqual([...request.preselect], ['existing']); return ['existing', 'new', 'another']; },
    addItemsToPlaylists: async (targets, tracks) => calls.push([[...targets], [...tracks]]),
  });
  await action(item);
  assert.deepEqual(calls, [[['new', 'another'], ['song']]]);
});

test('cancelling the shared playlist picker does not mutate playlists', async () => {
  const action = vm.runInNewContext(`${between('async function addTrackToPlaylists(', '/** 搜索结果 / 链接解析结果的')}; addTrackToPlaylists`, {
    FAVORITES_ID: 'favorites', get: () => ({ playlists: [] }), askPlaylists: async () => null,
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

test('add mode can remove an existing favorite without changing other playlist membership', async () => {
  const calls = [];
  const action = vm.runInNewContext(`${between('async function addTrackToPlaylists(', '/** 搜索结果 / 链接解析结果的')}; addTrackToPlaylists`, {
    FAVORITES_ID: 'favorites', get: () => ({ playlists: [] }), playlistsOf: () => ['favorites', 'existing'],
    askPlaylists: async () => [],
    playlistStore: { removeTracks: async (id, tracks) => calls.push([id, [...tracks]]) },
    addItemsToPlaylists: () => assert.fail('removing a favorite must not add other playlists'),
  });
  await action({ id: 'song', localId: 'saved' });
  assert.deepEqual(calls, [['favorites', ['saved']]]);
});

const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : [];
for (const mode of ['download', 'import', 'add']) test(`favorite checkbox works in ${mode} picker`, () => {
  const req = { mode, title: '选择歌单', preselect: mode === 'add' ? ['favorites'] : [] };
  const state = { playlistPicker: req, playlists: [{ id: 'favorites', name: '我喜欢的音乐', trackIds: ['saved'] }, { id: 'other', name: 'Other', trackIds: [] }] };
  const values = [], effects = []; let cursor = 0, result;
  const Component = vm.runInNewContext(`${between('function PlaylistPicker()', '/** 房间顶部')}; PlaylistPicker`, {
    FAVORITES_ID: 'favorites', useStore: fn => fn(state), useBackLayer() {},
    useState: initial => { const i = cursor++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], v => values[i] = typeof v === 'function' ? v(values[i]) : v]; },
    useEffect: fn => effects.push(fn), html: htm.bind(React.createElement), cx: (...args) => args.filter(Boolean).join(' '),
    ListPlus: () => null, X: () => null, Plus: () => null, PlaylistCover: () => null,
    closePlaylistPicker: value => result = [...value],
  });
  const render = () => { cursor = 0; return flatten(Component()); };
  render(); effects.shift()();
  let nodes = render();
  const findFavorite = () => nodes.find(n => n.type === 'label' && String(n.props.children).includes('同时标记为我喜欢')).props.children[0];
  assert.equal(findFavorite().props.checked, mode === 'add');
  assert.ok(!findFavorite().props.disabled);
  assert.equal(nodes.filter(n => n.type === 'label' && flatten(n).some(c => c.type?.name === 'PlaylistCover')).length, 1, 'favorites is excluded from playlist rows');
  findFavorite().props.onChange({ target: { checked: mode !== 'add' } });
  nodes = render();
  const confirm = nodes.find(n => n.type === 'button' && n.props.onClick && /保存修改|到 1 个歌单/.test(String(n.props.children)));
  assert.ok(confirm); assert.equal(confirm.props.disabled, false);
  confirm.props.onClick();
  assert.deepEqual(result, mode === 'add' ? [] : ['favorites']);
});
