import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import htm from 'htm';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppToast, restoreDownloads, persistDownloads, orderedDownloads } from '../public/dashboardFeedback.js';

const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const between = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));

test('dashboard toast replaces all keys and restarts one dismissal timer', () => {
  let current, next = 0;
  const timers = new Map();
  const toast = createAppToast(value => current = value, { schedule: fn => (timers.set(++next, fn), next), cancel: id => timers.delete(id) });
  toast('单曲循环', 'info', { key: 'play-mode', icon: 'loopOne' });
  toast('随机播放', 'info', { key: 'play-mode', icon: 'shuffle' });
  assert.equal(current.length, 1);
  assert.equal(current[0].icon, 'shuffle');
  toast('失败', 'warn');
  assert.equal(current[0].kind, 'warn');
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.deepEqual(current, []);
});

test('dashboard failure survives searches and reload; retry keeps source and format', async () => {
  let state = { downloads: {}, results: [] }, saved;
  const calls = [], notices = [];
  const storage = { getItem: () => saved, setItem: (_, value) => saved = value };
  const ctx = {
    get: () => state, set: patch => Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
    updateDownload: (id, patch) => { state.downloads[id] = { ...state.downloads[id], ...patch }; persistDownloads(storage, state.downloads); },
    api: { download: async (r, progress) => { calls.push(r); progress(0.4); throw new Error('网络断开'); } },
    toast: text => notices.push(text), session: {},
  };
  const download = vm.runInNewContext(`${between('async function downloadResult(', '/** Guest：等房主')}; downloadResult`, ctx);
  const result = { id: 'youtube:abc', title: '歌曲', artist: '歌手', cover: 'https://i.ytimg.com/vi/abc/hqdefault.jpg', downloadFormat: 'm4a' };
  assert.equal(await download(result, null, { playlists: ['inbox'] }), false);
  state.results = [{ id: 'other' }];
  state.downloads = restoreDownloads(storage);
  const retained = state.downloads[result.id];
  assert.equal(retained.cover, result.cover);
  assert.deepEqual(retained.playlists, ['inbox']);
  await download({ ...retained.result, downloadFormat: retained.format }, null, { playlists: retained.playlists });
  assert.equal(calls[1].id, result.id);
  assert.equal(calls[1].downloadFormat, 'm4a');
  assert.match(notices.at(-1), /歌曲.*下载失败.*下载队列/);
  state.downloads[result.id].status = 'downloading';
  persistDownloads(storage, state.downloads);
  assert.equal(restoreDownloads(storage)[result.id].error, '已中断，请重新下载');
});

test('queue shows failure reason, progress, retry and completed controls in priority order', () => {
  const jobs = {
    done: { title: '完成', result: { id: 'done' }, status: 'done', format: 'm4a', createdAt: 3 },
    active: { title: '进行中', result: { id: 'active' }, status: 'downloading', progress: 0.42, format: 'm4a', createdAt: 2 },
    failed: { title: '失败曲目', result: { id: 'failed' }, status: 'error', error: '网络断开', format: 'best', createdAt: 1 },
  };
  const state = { downloads: jobs, downloadQueueOpen: true };
  const Sheet = vm.runInNewContext(`${between('function DownloadQueueSheet()', 'function Toasts()')}; DownloadQueueSheet`, {
    html: htm.bind(React.createElement), useStore: fn => fn(state), useBackLayer() {}, orderedDownloads,
    cx: (...args) => args.filter(Boolean).join(' '), X: () => null, Cover: () => null,
  });
  const markup = renderToStaticMarkup(React.createElement(Sheet));
  assert.ok(markup.indexOf('失败曲目') < markup.indexOf('进行中'));
  assert.ok(markup.indexOf('进行中') < markup.indexOf('>完成<'));
  for (const text of ['网络断开', '42%', '重新下载', '清除已完成']) assert.ok(markup.includes(text), text);
});

test('connected host and guest play-mode taps both give feedback', () => {
  const notices = [];
  const methods = vm.runInNewContext(`({${between('  setPlayMode(mode)', '\n  get isGuest()')}})`, {
    toast: (...args) => notices.push(args), set() {}, localStorage: { setItem() {} }, MODE_LABEL: { shuffle: '随机播放' },
  });
  const host = { ...methods, conn: { open: true }, queue: { mode: 'shuffle' }, syncQueue() { return { setMode() {} }; }, broadcastLibrary() {}, notifySynced() {} };
  host.setPlayMode('shuffle');
  assert.equal(notices[0][0], '随机播放');
  assert.equal(notices[0][2].icon, 'shuffle');
  host.isGuest = true;
  host.setPlayMode('shuffle');
  assert.equal(notices[1][0], '播放模式由房主控制');
  assert.doesNotMatch(between('function PlayModeButton()', 'function PlayerBar()'), /disabled=\$\{isGuest\}/);
});

test('cloud queue retries the retained resolved source without searching and replaces the original pending row', async () => {
  const state = { downloads: {}, pendingJobs: {} }, replacements = [], downloaded = [];
  const downloadPending = vm.runInNewContext(`${between('async function downloadPending(', '/** 原音源失效')}; downloadPending`, {
    get: () => state, set: fn => Object.assign(state, fn(state)),
    updateDownload: (id, patch) => state.downloads[id] = { ...state.downloads[id], ...patch },
    api: { search: () => assert.fail('retry must not re-search') },
    playlistStore: { replacePending: async (...args) => replacements.push(args) },
    cacheCloudTrack: async (track, { download }) => download(track), LocalLib: {}, account: {},
    downloadCloudTrack: async (_, track, progress) => { downloaded.push(track); progress(0.5); },
    session: { restoreLocal: async () => {} }, cloudSync: { sync: async () => {} }, toast() {},
  });
  await downloadPending('playlist', null, { id: 'search:old', sourceId: 'bilibili:BV1', title: '歌曲', artist: '歌手' });
  assert.equal(downloaded[0].sourceId, 'bilibili:BV1');
  assert.equal(replacements[0][1], 'search:old');
  assert.equal(replacements[0][2].id, 'bilibili:BV1');
  assert.equal(state.downloads['cloud:playlist:search:old'].status, 'done');
});
