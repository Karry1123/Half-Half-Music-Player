import { gainFor, trimBounds } from '../public/audioAnalysis.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readLastPlayback, createPlaybackWriter, LAST_PLAYBACK_KEY } from '../public/playbackResume.js';
import { PlayQueue } from '../public/playQueue.js';
import { resolveScope, ALL_ID } from '../public/playlists.js';
import { installNativePlayback } from '../public/nativePlayback.js';
const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const memory = () => { const values = new Map(); return { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) }; };

test('checkpoints store the track and queue context once per change, never the position', () => {
  const storage = memory();
  const write = createPlaybackWriter({ storage });
  const state = { library: [{ id: 'a' }], currentId: 'a', playing: true, playMode: 'shuffle', activePlaylistId: 'p' };
  const session = { anchor: { trackId: 'a', position: 12 }, position: () => 20, viewOrder: { playlistId: 'p', ids: ['a'] } };
  assert.equal(write(state, session), true);
  assert.deepEqual(JSON.parse(storage.getItem(LAST_PLAYBACK_KEY)), { version: 2, trackId: 'a', activePlaylistId: 'p', viewOrder: session.viewOrder, playMode: 'shuffle' });
  session.anchor.position = 42; state.playing = false; assert.equal(write(state, session), false); // progress alone never writes
  state.playMode = 'order'; assert.equal(write(state, session), true);
  state.role = 'guest'; assert.equal(write(state, session), false);
  state.role = null; state.currentId = 'b'; assert.equal(write(state, session), false);
});

test('restore rejects guest, missing tracks, old formats and malformed data; validates scope and starts from zero', () => {
  const storage = memory(), state = { library: [{ id: 'a', duration: 100 }] };
  const saved = { version: 2, trackId: 'a', activePlaylistId: 'p', viewOrder: { playlistId: 'p', ids: ['missing', 'a'] }, playMode: 'shuffle' };
  storage.setItem(LAST_PLAYBACK_KEY, JSON.stringify(saved));
  const playlists = { get: () => ({ id: 'p', trackIds: ['a'] }) };
  const restored = readLastPlayback(state, playlists, storage);
  assert.equal(restored.position, 0); assert.equal(restored.activePlaylistId, 'p'); assert.equal(restored.playMode, 'shuffle');
  assert.deepEqual(restored.viewOrder.ids, ['a']);
  assert.equal(readLastPlayback({ ...state, role: 'guest' }, playlists, storage), null);
  assert.equal(readLastPlayback({ library: [] }, playlists, storage), null);
  assert.equal(readLastPlayback(state, { get: () => null }, storage).activePlaylistId, null);
  assert.equal(readLastPlayback(state, { get: () => null }, storage).viewOrder, null);
  storage.setItem(LAST_PLAYBACK_KEY, JSON.stringify({ ...saved, version: 1, position: 42 })); assert.equal(readLastPlayback(state, playlists, storage), null);
  storage.setItem(LAST_PLAYBACK_KEY, '{'); assert.equal(readLastPlayback(state, playlists, storage), null);
});

function harness(storage) {
  const state = { library: [{ id: 'a', localId: 'a', duration: 100 }, { id: 'b', localId: 'b', duration: 100 }], playMode: 'order' };
  const playlists = { get: () => ({ id: 'p', trackIds: ['a', 'b'] }) };
  const Session = vm.runInNewContext(`${section('class Session {', 'const session = new Session();')}; Session`, {
    trimBounds,
    get: () => state, set: patch => Object.assign(state, patch), now: () => 0, clearTimeout, queueMicrotask, updateMediaPosition() {},
    readLastPlayback: s => readLastPlayback(s, playlists, storage), playlistStore: playlists, resolveScope, ALL_ID,
  });
  const session = Object.assign(Object.create(Session.prototype), {
    _analysisQueue: { enqueue() {} },
    anchor: {}, token: 0, sendGen: 0, blobs: new Map([['a', {}], ['b', {}]]), queue: new PlayQueue(),
    out: { setEndBoundary() {}, intent: false, pausedAt: 0, audio: { src: '', readyState: 0, currentTime: 0, duration: 100 }, unlock() {}, position() { return this.pausedAt; },
      stopAt(_, pos) { this.pausedAt = pos; this.audio.currentTime = pos; this.intent = false; },
      async load(_, opts) { this.options = opts; this.pausedAt = opts.position; this.audio.src = 'blob:new'; this.audio.readyState = 4; return 100; },
      playAt(_, pos) { this.playedAt = pos; this.intent = true; },
    }, send() {}, broadcastLibrary() {}, notifySynced() {},
  });
  return { session, state };
}

test('cold restore stays paused and queued widget play starts the remembered track from zero; next follows saved scope', async () => {
  const storage = memory(); storage.setItem(LAST_PLAYBACK_KEY, JSON.stringify({ version: 2, trackId: 'a', activePlaylistId: 'p', playMode: 'order', viewOrder: { playlistId: 'p', ids: ['a', 'b'] } }));
  const { session, state } = harness(storage);
  const updates = []; let action;
  const bridge = installNativePlayback({ plugin: { addListener: async (_, fn) => { action = fn; }, update: async s => updates.push(s) },
    store: { subscribe() {} }, get: () => state, session, doc: { addEventListener() {} } });
  action({ action: 'play' }); session.restorePlayback();
  assert.equal(state.currentId, 'a'); assert.equal(state.loaded, false); assert.equal(session.out.intent, false);
  assert.equal(session.position(), 0); assert.equal(session.syncQueue().peekNext(), 'b');
  bridge.markReady();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(updates[0].subtitle, '点按打开 App 继续'); assert.equal(updates[0].playing, false); assert.equal(updates[0].hold, false); assert.equal(updates[0].position, 0);
  assert.equal(session.out.playedAt, 0);
});

test('long pause uses pausedAt even if currentTime reset and reloads missing media before seeking/play', async () => {
  const { session, state } = harness(memory());
  Object.assign(state, { currentId: 'a', duration: 100, loaded: true });
  session.loadedId = 'a'; session.anchor = { trackId: 'a', playing: false, position: 42 };
  session.out.pausedAt = 42;
  await session.act('play');
  assert.equal(session.out.options.position, 42); assert.equal(session.out.playedAt, 42);
  session.out.stopAt(0, 55); session.anchor.playing = false; session.out.audio.currentTime = 0;
  session.act('play'); assert.equal(session.out.playedAt, 55);
});
