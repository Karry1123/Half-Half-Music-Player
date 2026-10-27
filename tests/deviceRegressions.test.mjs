import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCoverBackfill, sourcePage } from '../public/libraryCoverBackfill.js';
import { coverCandidates, coverError } from '../public/coverUrl.js';
import React from 'react';
import htm from 'htm';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('guest track metadata renders before library/audio arrive, including quiet reconnects', () => {
  const state = { library: [], offline: { hashes: new Set() } }, sent = [];
  const methods = vm.runInNewContext(`({${between('  guestTrack(m)', '  async guestLoad(')}})`, {
    get: () => state, set: patch => Object.assign(state, typeof patch === 'function' ? patch(state) : patch), now: () => 0, note() {},
  });
  const target = { ...methods, anchor: {}, loadedId: null, token: 0, drift: { reset() {} }, out: { stopAt() {} }, blobs: new Map(), incoming: new Map(), send: m => sent.push(m) };
  const meta = { id: 'host-song', title: '歌曲', artist: '歌手', cover: 'https://localhost/_capacitor_file_/host.cover', coverUrl: 'https://example.com/cover.jpg' };
  target.guestTrack({ meta, by: 'host', quiet: true });
  assert.equal(state.library.find(t => t.id === state.currentId)?.title, meta.title);
  assert.equal(state.loaded, false);
  assert.equal(sent[0].type, 'need');
  target.loadedId = meta.id;
  state.library = [];
  target.guestTrack({ meta, quiet: true });
  assert.equal(state.library[0].cover, meta.coverUrl);
});

test('host library alone starts guest audio acquisition; following quiet track does not request twice', () => {
  const state = { role: 'guest', library: [], offline: { hashes: new Set() } }, sent = [];
  const context = { get: () => state, set: patch => Object.assign(state, typeof patch === 'function' ? patch(state) : patch), now: () => 0, note() {} };
  const methods = vm.runInNewContext(`({${between('  guestTrack(m)', '  async guestLoad(')},${between('  onMessage(m)', '  // ───────────────────────── 操作入口')}})`, context);
  const target = { ...methods, isGuest: true, anchor: {}, loadedId: null, token: 0, drift: { reset() {} }, out: { stopAt() {} }, blobs: new Map(), incoming: new Map(), prefetchNext() {}, send: m => sent.push(m) };
  const meta = { id: 'host-song', title: '歌曲', artist: '歌手', duration: 100 };
  target.onMessage({ type: 'library', items: [meta], currentId: meta.id });
  target.onMessage({ type: 'track', meta, by: 'host', quiet: true });
  assert.equal(state.library.find(t => t.id === state.currentId).title, meta.title);
  assert.equal(state.duration, 100);
  assert.equal(sent.filter(m => m.type === 'need').length, 1);
});

test('guest hello replays host library, track and state once the guest channel is ready', () => {
  const meta = { id: 'song', title: '歌曲' }, sent = [], state = { library: [meta], currentId: 'song', me: {} };
  const methods = vm.runInNewContext(`({${between('  onMessage(m)', '  // ───────────────────────── 操作入口')},${between('  sendSnapshot()', '  notifySynced()')}})`, {
    get: () => state, set: patch => Object.assign(state, patch),
  });
  const target = { ...methods, isGuest: false, anchor: { trackId: 'song', playing: true, position: 12, at: 100 }, broadcastLibrary: () => sent.push({ type: 'library' }), send: m => sent.push(m) };
  target.onMessage({ type: 'hello', name: '好友' });
  assert.deepEqual(sent.map(m => m.type), ['library', 'track', 'state']);
  assert.equal(sent[1].meta.title, meta.title); assert.equal(sent[2].position, 12);
});

test('guest mini and fullscreen players show metadata and transfer status before audio is loaded', () => {
  const item = { id: 'song', title: '歌曲标题', artist: '歌曲作者', cover: 'https://example.com/cover.jpg' };
  const state = { library: [item], currentId: item.id, role: 'guest', conn: 'open', loaded: false, volume: 1 };
  const context = {
    html: htm.bind(React.createElement), useStore: fn => fn(state), useState: () => [0, () => {}], useRef: () => ({ current: null }), useBackLayer() {}, useEffect() {},
    cx: (...args) => args.filter(Boolean).join(' '), gradient: () => 'red', coverSrc: url => url, coverCandidates, coverError, trackCompletedCount: () => 0, session: {},
    ...Object.fromEntries(['Music2', 'UpNextPanel', 'CoListenPill', 'Pause', 'Play', 'SkipForward', 'ChevronDown', 'SeekBar', 'PlayModeButton', 'SkipBack', 'ListMusic', 'Volume2', 'VolumeX', 'SyncStatus'].map(name => [name, () => null])),
  };
  const Player = vm.runInNewContext(`${between('function Cover(', 'function Panel(')};${between('function NativePlayer(', 'function App()')}; NativePlayer`, context);
  for (const open of [false, true]) {
    const markup = renderToStaticMarkup(React.createElement(Player, { open, close() {}, expand() {} }));
    for (const text of [item.title, item.artist, item.cover, '正在从好友获取音频…']) assert.ok(markup.includes(text), text);
    assert.doesNotMatch(markup, /从曲库选择一首歌|未在播放/);
  }
});

test('cover backfill persists metadata with two workers and attempts each missing cover once', async () => {
  let active = 0, peak = 0, resolved = 0;
  const saved = [], refreshed = [];
  const repair = createCoverBackfill({ available: () => true,
    resolve: async url => { resolved++; active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active--; return { cover: url + '/cover.jpg' }; },
    save: async (id, coverUrl) => { saved.push(id); return { id, coverUrl, hasCover: true }; }, onCover: t => refreshed.push(t),
  });
  const tracks = Array.from({ length: 6 }, (_, i) => ({ id: String(i), sourceId: `youtube:video${i}` }));
  tracks.push({ id: 'complete', hasCover: true }, { id: 'local' }, { id: 'remote-only', coverUrl: 'https://example.com/cover.jpg' });
  await repair(tracks);
  await repair(tracks);
  assert.equal(peak, 2); assert.equal(resolved, 6); assert.equal(saved.length, 7); assert.equal(refreshed.length, 7);
  assert.equal(sourcePage({ sourceId: 'bilibili:BV123' }), 'https://www.bilibili.com/video/BV123');
  assert.equal(sourcePage({ source: 'ytmusic', sourceId: 'abc' }), 'https://music.youtube.com/watch?v=abc');
});

test('unreachable API stops backfill silently without a retry storm', async () => {
  let calls = 0, online = false;
  const repair = createCoverBackfill({ available: () => online, resolve: async () => { calls++; throw new Error('offline'); }, save: () => assert.fail(), onCover: () => assert.fail() });
  const tracks = Array.from({ length: 100 }, (_, i) => ({ id: String(i), pageUrl: 'https://example.com/song' }));
  await repair(tracks); assert.equal(calls, 0);
  online = true;
  await repair(tracks); await repair(tracks);
  assert.ok(calls > 0 && calls <= 2);
});
