import { gainFor, trimBounds } from '../public/audioAnalysis.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resumePosition, readLastPlayback, createPlaybackWriter, LAST_PLAYBACK_KEY } from '../public/playbackResume.js';
import { PlayQueue } from '../public/playQueue.js';
import { resolveScope, ALL_ID } from '../public/playlists.js';
import { installNativePlayback } from '../public/nativePlayback.js';
const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const memory = () => { const values = new Map(); return { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) }; };

test('versioned checkpoints throttle progress for five seconds, force pause/seek and save context changes', () => {
  const storage = memory(); let now = 0;
  const write = createPlaybackWriter({ storage, now: () => now });
  const state = { library: [{ id: 'a' }], currentId: 'a', playing: true, playMode: 'shuffle', activePlaylistId: 'p' };
  const session = { anchor: { trackId: 'a', position: 12 }, position: () => 20, viewOrder: { playlistId: 'p', ids: ['a'] } };
  assert.equal(write(state, session), true);
  assert.deepEqual(JSON.parse(storage.getItem(LAST_PLAYBACK_KEY)), { version: 1, trackId: 'a', position: 20, activePlaylistId: 'p', viewOrder: session.viewOrder, playMode: 'shuffle' });
  now = 4999; assert.equal(write(state, session), false);
  now = 5000; assert.equal(write(state, session), true);
  state.playing = false; assert.equal(write(state, session), true);
  session.anchor.position = 42; assert.equal(write(state, session, true), true);
  assert.equal(JSON.parse(storage.getItem(LAST_PLAYBACK_KEY)).position, 42);
  state.role = 'guest'; assert.equal(write(state, session, true), false);
  state.role = null; state.currentId = 'b'; assert.equal(write(state, session, true), false);
});

test('restore rejects guest, missing tracks and malformed data; validates scope and clamps completed positions', () => {
  const storage = memory(), state = { library: [{ id: 'a', duration: 100 }] };
  const saved = { version: 1, trackId: 'a', position: 98, activePlaylistId: 'p', viewOrder: { playlistId: 'p', ids: ['missing', 'a'] }, playMode: 'shuffle' };
  storage.setItem(LAST_PLAYBACK_KEY, JSON.stringify(saved));
  const playlists = { get: () => ({ id: 'p', trackIds: ['a'] }) };
  const restored = readLastPlayback(state, playlists, storage);
  assert.equal(restored.position, 0); assert.equal(restored.activePlaylistId, 'p');
  assert.deepEqual(restored.viewOrder.ids, ['a']);
  assert.equal(readLastPlayback({ ...state, role: 'guest' }, playlists, storage), null);
  assert.equal(readLastPlayback({ library: [] }, playlists, storage), null);
  assert.equal(readLastPlayback(state, { get: () => null }, storage).activePlaylistId, null);
  assert.equal(readLastPlayback(state, { get: () => null }, storage).viewOrder, null);
  storage.setItem(LAST_PLAYBACK_KEY, '{'); assert.equal(readLastPlayback(state, playlists, storage), null);
  for (const p of [97, 99, 100, 120]) assert.equal(resumePosition(p, 100), 0);
  assert.equal(resumePosition(96, 100), 96); assert.equal(resumePosition(-1, 100), 0);
  assert.equal(resumePosition(NaN, 100), 0);
});

function harness(storage) {
  const state = { library: [{ id: 'a', localId: 'a', duration: 100 }, { id: 'b', localId: 'b', duration: 100 }], playMode: 'order' };
  const playlists = { get: () => ({ id: 'p', trackIds: ['a', 'b'] }) };
  const Session = vm.runInNewContext(`${section('class Session {', 'const session = new Session();')}; Session`, {
    trimBounds,
    get: () => state, set: patch => Object.assign(state, patch), now: () => 0, clearTimeout, queueMicrotask, updateMediaPosition() {},
    resumePosition, readLastPlayback: s => readLastPlayback(s, playlists, storage), playlistStore: playlists, resolveScope, ALL_ID,
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

test('cold restore stays paused and queued widget play reloads at checkpoint; next follows saved scope', async () => {
  const storage = memory(); storage.setItem(LAST_PLAYBACK_KEY, JSON.stringify({ version: 1, trackId: 'a', position: 42, activePlaylistId: 'p', playMode: 'order', viewOrder: { playlistId: 'p', ids: ['a', 'b'] } }));
  const { session, state } = harness(storage);
  const updates = []; let action;
  const bridge = installNativePlayback({ plugin: { addListener: async (_, fn) => { action = fn; }, update: async s => updates.push(s) },
    store: { subscribe() {} }, get: () => state, session, doc: { addEventListener() {} } });
  action({ action: 'play' }); session.restorePlayback();
  assert.equal(state.currentId, 'a'); assert.equal(state.loaded, false); assert.equal(session.out.intent, false);
  assert.equal(session.position(), 42); assert.equal(session.syncQueue().peekNext(), 'b');
  bridge.markReady();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(updates[0].subtitle, '点按打开 App 继续'); assert.equal(updates[0].playing, false); assert.equal(updates[0].hold, false); assert.equal(updates[0].position, 42);
  assert.equal(session.out.playedAt, 42);
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
