import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import htm from 'htm';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlayQueue, PLAY_MODES } from '../public/playQueue.js';
import { resolveScope } from '../public/playlists.js';
import { ListeningStats } from '../public/listeningStats.js';

test('statistics cards render period buckets, two rings, plain comparisons and clean headings', async () => {
  const stats = new ListeningStats({ userId: 'alice', indexedDB: null });
  await stats.ready();
  const now = +new Date(2026, 9, 15, 12);
  stats.cloud = { daily: [{ day: '2026-10-15', seconds: 720 }] };
  stats.stats.completedPlayCount.song = 128;
  stats.records = [60, 600, 1800, 3600].map((durationPlayed, hour) => ({ timestamp: +new Date(2026, 9, 12, hour), durationPlayed }));
  const code = readFileSync(new URL('../public/statsUI.js', import.meta.url), 'utf8')
    .replace(/^\uFEFF/, '').replace(/^import .*;\r?\n/gm, '').replace('export function ListeningStatsCards', 'function ListeningStatsCards');
  for (const [period, heading, points] of [['week', '每日收听', 7], ['month', '每周收听', 5], ['year', '每月收听', 12], ['all', '每年收听', 2]]) {
    const Cards = vm.runInNewContext(`${code}; ListeningStatsCards`, {
      React, htm, Date: class extends Date { static now() { return now; } },
      useState: value => [value === 'week' ? period : value, () => {}],
      useEffect() {}, useRef: () => ({ current: null }),
    });
    const markup = renderToStaticMarkup(React.createElement(Cards, { stats }));
    assert.match(markup, new RegExp(`>${heading}</h3>`));
    assert.equal((markup.match(/class="stats-ring"/g) || []).length, 2);
    assert.equal((markup.match(/<g>/g) || []).length, points);
    assert.match(markup, /128.*次/);
    assert.doesNotMatch(markup, /活跃天数|>一起听<|累计|本机|触摸查看|↑|↓/);
    for (const alpha of ['0.45', '0.65', '0.85', '1']) assert.ok(markup.includes(` / ${alpha})`));
    assert.match(markup, /prefers-reduced-motion/);
    if (period === 'week') assert.match(markup, /较上周增加 113 分钟/);
    if (period === 'month') assert.match(markup, /较上月增加 113 分钟/);
    if (period === 'year') assert.match(markup, /今年至今/);
    if (period === 'all') assert.match(markup, /全部记录/);
  }
});

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
    useState: React.useState, useEffect: React.useEffect, cx: (...args) => args.filter(Boolean).join(' '),
    session: {}, ALL_ID: 'all', ALL_NAME: '全部歌曲', X: () => null, ArrowRight: () => null, ChevronRight: () => null, PlaylistCover: () => null,
  });
  const host = renderToStaticMarkup(React.createElement(functions.CoListenDrawer));
  assert.match(host, /更换同听歌单/); assert.match(host, /42/); assert.match(host, /好友昵称/);
  const queue = renderToStaticMarkup(React.createElement(functions.QueueSheet));
  assert.match(queue, /我的歌单/); assert.match(queue, /2.*首/);
  state = { ...state, role: 'guest' };
  const guest = renderToStaticMarkup(React.createElement(functions.CoListenDrawer));
  assert.doesNotMatch(guest, /更换同听歌单/); assert.match(guest, /由好友控制/);
  assert.equal(renderToStaticMarkup(React.createElement(functions.QueueSheet)), '');
});

test('sheet playback shortcuts override mode; selecting a track preserves repeat/shuffle and broadcasts selection', async () => {
  const state = { playMode: 'loopOne', library: [], currentId: 'old' }, events = [], saved = [];
  const playlist = { id: 'p', name: '歌单', trackIds: ['a', 'b', 'c'] };
  const methods = vm.runInNewContext(`({${between('  async playPlaylist(', '  /** 房主：告诉 Guest')}})`, {
    get: () => state, set: patch => Object.assign(state, patch), ALL_ID: 'all', PLAY_MODES, PlayQueue,
    playlistStore: { get: () => playlist }, missingFromLibrary: () => [], ensureInLibrary: async () => {},
    localStorage: { setItem: (...args) => saved.push(args) },
  });
  const target = { ...methods, scopeIds: () => playlist.trackIds, announcePlaylist: () => events.push('playlist'),
    notifySynced: () => events.push('synced'), loadTrack: async function(id, options) {
      events.push(id); assert.equal(options.autoplay, true); this.queue.moveTo(id);
    } };
  for (const mode of ['loopOne', 'loopAll', 'shuffle']) {
    state.playMode = mode;
    await target.playPlaylist('p', { startItemId: 'b' });
    assert.equal(state.playMode, mode);
    assert.deepEqual(events.splice(0), ['playlist', 'b', 'synced']);
    assert.deepEqual([...target.queue.ids], ['a', 'b', 'c']);
  }
  await target.playPlaylist('p', { mode: 'order' });
  assert.equal(state.playMode, 'order'); assert.equal(target.queue.current, 'a');
  await target.playPlaylist('p', { mode: 'shuffle' });
  assert.equal(state.playMode, 'shuffle'); assert.ok(playlist.trackIds.includes(target.queue.current));
  assert.ok(!target.queue.bag.includes(target.queue.current));
  assert.deepEqual(saved, [['hh.playMode', 'order'], ['hh.playMode', 'shuffle']]);
});

test('playlist detail renders every local and pending track with completed counts and current highlight', () => {
  const state = { queueSheetOpen: true, role: 'host', currentId: 'b', pendingJobs: { cloud: { state: 'error', message: '下载失败' } },
    library: [{ id: 'a', localId: 'la', title: '第一首', artist: '歌手' }, { id: 'b', localId: 'lb', title: '第二首', artist: '歌手' }],
    playlists: [{ id: 'p', name: '一个很长的歌单名称', trackIds: ['la', 'lb'], pending: [{ id: 'cloud', title: '云端歌曲' }] }] };
  let hook = 0;
  const QueueSheet = vm.runInNewContext(`${between('function QueueSheet()', 'function NativePlayer(')}; QueueSheet`, {
    html: htm.bind(React.createElement), useStore: fn => fn(state), useBackLayer() {}, set() {}, useEffect() {},
    useState: () => [hook++ === 0 ? 'p' : false, () => {}], resolveScope,
    cx: (...args) => args.filter(Boolean).join(' '), trackCompletedCount: t => t.id === 'b' ? 3 : 0,
    ALL_ID: 'all', ALL_NAME: '全部歌曲', session: {}, Cover: () => null,
    X: () => null, ArrowRight: () => null, Shuffle: () => null, ListOrdered: () => null, Music2: () => null, CloudDownload: () => null,
  });
  const markup = renderToStaticMarkup(React.createElement(QueueSheet));
  for (const text of ['返回歌单列表', '随机播放', '顺序播放', '第一首', '第二首', '云端歌曲', '已听 3 次', '点击重试下载']) assert.ok(markup.includes(text), text);
  assert.doesNotMatch(markup, /已听 0 次/);
  assert.match(markup, /aria-current="true"/);
});
