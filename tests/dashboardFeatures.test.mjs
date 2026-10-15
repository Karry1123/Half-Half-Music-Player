import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import htm from 'htm';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlayQueue } from '../public/playQueue.js';

const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('blank account profile uses its username without writing the device nickname to the server', async () => {
  const calls = [], names = [];
  const sync = vm.runInNewContext(`(${between('async function syncProfile()', 'const ASK_PLAYLIST_KEY')})`, {
    cloudSync: { enabled: true }, console,
    account: { user: { username: 'sidchy03' }, request: async (...args) => { calls.push(args); return { nickname: '' }; } },
    setMyName: async (...args) => names.push(args),
    get: () => ({ me: { name: '橘子汽水' } }),
  });
  await sync();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/account/profile');
  assert.equal(names[0][0], 'sidchy03');
  assert.equal(names[0][1].push, false);
});

test('rejected nickname saves keep the current local identity and report the Chinese conflict', async () => {
  const notices = [];
  const rename = vm.runInNewContext(`(${between('async function setMyName(', '/** 登录后以账号资料')})`, {
    cloudSync: { enabled: true },
    account: { request: async () => { throw Object.assign(new Error('conflict'), { code: 'NICKNAME_TAKEN' }); } },
    toast: text => notices.push(text), set: () => assert.fail('must not change identity'),
  });
  assert.equal(await rename('占用昵称'), false);
  assert.match(notices[0], /该昵称已被使用/);
});

test('playlist switch clears previous history and starts at track one, or a shuffled track', async () => {
  let state = { playMode: 'order' };
  const pl = { id: 'new', name: '新歌单', trackIds: ['a', 'b', 'c'] };
  const methods = vm.runInNewContext(`({${between('  async playPlaylist(', '  /** 房主：告诉 Guest')}})`, {
    get: () => state, set: patch => Object.assign(state, patch), ALL_ID: 'all',
    playlistStore: { get: () => pl }, missingFromLibrary: () => [], ensureInLibrary: async () => {}, PlayQueue,
  });
  for (const mode of ['order', 'shuffle']) {
    state.playMode = mode;
    const queue = new PlayQueue(); queue.forward = ['old'];
    let selected;
    const target = { ...methods, queue, scopeIds: () => pl.trackIds, announcePlaylist() {}, notifySynced() {}, loadTrack: async id => { selected = id; } };
    await target.playPlaylist('new');
    assert.ok(pl.trackIds.includes(selected));
    if (mode === 'order') assert.equal(selected, 'a');
    assert.equal(target.queue.forward.length, 0);
  }
});

test('co-listen sheets render host controls and guest read-only status', () => {
  let state = { coListenOpen: true, queueSheetOpen: true, role: 'host', conn: 'open', ping: 42, peer: { name: '好友昵称' }, library: [], playlists: [{ id: 'p', name: '我的歌单', trackIds: ['a', 'b'] }] };
  const functions = vm.runInNewContext(`${between('function CoListenPill()', 'function NativePlayer(')}; ({CoListenDrawer, QueueSheet})`, {
    html: htm.bind(React.createElement), useStore: fn => fn(state), useBackLayer() {}, set() {},
    session: {}, ALL_ID: 'all', ALL_NAME: '全部歌曲', X: () => null,
  });
  const host = renderToStaticMarkup(React.createElement(functions.CoListenDrawer));
  assert.match(host, /更换同听歌单/); assert.match(host, /42/); assert.match(host, /好友昵称/);
  const queue = renderToStaticMarkup(React.createElement(functions.QueueSheet));
  assert.match(queue, /我的歌单/); assert.match(queue, /2.*首/);
  state = { ...state, role: 'guest' };
  const guest = renderToStaticMarkup(React.createElement(functions.CoListenDrawer));
  assert.doesNotMatch(guest, /更换同听歌单/); assert.match(guest, /由好友控制/);
});
