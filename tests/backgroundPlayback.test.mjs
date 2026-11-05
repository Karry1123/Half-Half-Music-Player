import { gainFor, trimBounds } from '../public/audioAnalysis.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PlayQueue } from '../public/playQueue.js';
import { installNativePlayback } from '../public/nativePlayback.js';

const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('hidden track transitions keep the native service held; explicit pause releases it', async () => {
  const updates = [], listeners = [];
  const state = { playing: true, library: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], currentId: 'a' };
  const session = { out: { intent: true }, position: () => 0, act() {} };
  const plugin = { update: async s => updates.push(s), setArtwork: async () => {}, requestNotifications: async () => ({ granted: true }), addListener: async () => {} };
  installNativePlayback({ plugin, store: { subscribe: fn => listeners.push(fn) }, get: () => state, session, fetchCover: async () => null, fallbackArtwork: () => 'data:image/png;base64,AA==', doc: { hidden: true, addEventListener() {} } });
  const publish = patch => { Object.assign(state, patch); listeners.forEach(fn => fn()); };
  publish({}); await drain();
  // ended -> asynchronous local load -> metadata: these are not a user pause.
  session.out.intent = false;
  publish({ playing: false, playbackPending: true, currentId: 'b' }); await drain();
  assert.equal(updates.every(u => u.hold), true);
  session.out.intent = true;
  publish({ playbackPending: false }); await drain();
  publish({ playing: true }); await drain();
  assert.equal(updates.at(-1).hold, true);
  assert.equal(updates.at(-1).trackId, 'b');
  session.out.intent = false;
  publish({ playing: false }); await drain();
  assert.equal(updates.at(-1).hold, false);
});

test('native actions queue until the library is restored, then run once', async () => {
  const acted = [];
  let listener;
  const state = { playing: false, library: [], currentId: null };
  const session = { out: { intent: false }, position: () => 0, act: (a, o) => acted.push([a, o]) };
  const plugin = { update: async () => {}, setArtwork: async () => {}, requestNotifications: async () => ({}), addListener: async (_, fn) => { listener = fn; } };
  const bridge = installNativePlayback({ plugin, store: { subscribe() {} }, get: () => state, session, fetchCover: async () => null, fallbackArtwork: () => 'data:,', doc: { hidden: false, addEventListener() {} } });
  await drain();
  listener({ action: 'next', position: 0 });
  listener({ action: 'seek', position: 12.5 });
  assert.deepEqual(acted, []);
  bridge.markReady();
  assert.deepEqual(acted, [['next', {}], ['seek', { position: 12.5 }]]);
  listener({ action: 'pause', position: 0 });
  assert.equal(acted.length, 3);
});

test('artwork is pushed once per track and the newest track wins', async () => {
  const art = [], listeners = [];
  const state = { playing: true, library: [{ id: 'a', title: 'A', cover: 'x' }, { id: 'b', title: 'B' }], currentId: 'a' };
  const session = { out: { intent: true }, position: () => 0, act() {} };
  let resolveA;
  const plugin = { update: async () => {}, setArtwork: async s => art.push(s.trackId), requestNotifications: async () => ({}), addListener: async () => {} };
  installNativePlayback({ plugin, store: { subscribe: fn => listeners.push(fn) }, get: () => state, session, doc: { hidden: true, addEventListener() {} },
    fetchCover: item => item.id === 'a' ? new Promise(r => { resolveA = r; }) : Promise.resolve(null), fallbackArtwork: () => 'data:image/png;base64,AA==' });
  const publish = patch => { Object.assign(state, patch); listeners.forEach(fn => fn()); };
  publish({}); publish({ duration: 10 }); await drain();
  publish({ currentId: 'b' }); await drain();
  resolveA(new Blob(['x'], { type: 'image/png' })); await drain();
  assert.deepEqual(art, ['b']);
});

function audioHarness(android = true) {
  class Audio extends EventTarget {
    paused = true; currentTime = 0; duration = 120; src = ''; plays = 0;
    pause() { this.paused = true; }
    play() { this.plays++; this.paused = false; return this.failure ? Promise.reject(this.failure) : Promise.resolve(); }
  }
  const AudioOut = vm.runInNewContext(`${section('class AudioOut {', '// ════════════════════════════════════════════════════════════ 会话引擎')}; AudioOut`, {
    stored: () => null, gainFor, audioDuck: 1,
    Audio, isAndroid: android, get: () => ({ volume: 1 }), now: () => 100,
    URL: { createObjectURL: () => 'blob:next', revokeObjectURL() {} },
    clearTimeout() {}, setTimeout() { assert.fail('solo playback must not depend on a timer'); },
  });
  return new AudioOut();
}

test('prepared local audio starts before metadata with no timer', async () => {
  const out = audioHarness();
  const loaded = out.load(new Blob(['audio']), { autoplay: true });
  assert.equal(out.audio.plays, 1);
  out.audio.onloadedmetadata();
  assert.equal(await loaded, 120);
});

test('play rejection reports the error and ends playback intent', async () => {
  const out = audioHarness();
  const failure = Object.assign(new Error('decode failed'), { name: 'NotSupportedError' });
  out.audio.failure = failure;
  let reported;
  out.onPlayError = error => { reported = error; };
  out.playAt(100, 0);
  await drain();
  assert.equal(reported, failure);
  assert.equal(out.intent, false);
});

for (const android of [true, false]) test(`eight local songs prefetch and advance synchronously on ${android ? 'Android' : 'web'} without bridge reads`, async () => {
  const state = { library: Array.from({ length: 8 }, (_, i) => ({ id: String(i), localId: String(i), duration: 120 })) };
  let reads = 0;
  const Session = vm.runInNewContext(`${section('class Session {', 'const session = new Session();')}; Session`, {
    trimBounds,
    get: () => state, set: patch => Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
    now: () => 100, isAndroid: android, console, queueMicrotask, updateMediaPosition() {}, clearTimeout() {},
    setTimeout() { assert.fail('solo playback must not schedule a timer'); },
    LocalLib: { getBlob: async () => { reads++; return new Blob(['audio']); } },
    toast: message => assert.fail(message),
  });
  const out = audioHarness(android);
  const session = Object.assign(Object.create(Session.prototype), {
    _analysisQueue: { enqueue() {} },
    out, blobs: new Map(), localLoaded: [], prefetching: new Set(), token: 0, sendGen: 0,
    queue: new PlayQueue(), anchor: {}, send() {}, scopeIds: () => state.library.map(x => x.id), playlistInfo: () => null,
  });
  out.onEnded = () => session.onEnded();
  const first = session.loadTrack('0', { autoplay: true });
  await drain(); out.audio.onloadedmetadata(); await first;
  for (let i = 1; i < 8; i++) {
    await drain(); // Prefetch finishes during the preceding song.
    const readsBeforeEnd = reads, playsBeforeEnd = out.audio.plays;
    out.audio.dispatchEvent(new Event('ended'));
    assert.equal(out.audio.plays, playsBeforeEnd + 1, 'play happens inside ended, before any await');
    assert.equal(state.currentId, String(i));
    assert.ok(reads - readsBeforeEnd <= 1, 'only the following song is being prefetched');
    out.audio.onloadedmetadata(); await drain();
    assert.equal(state.playbackPending, false);
    assert.equal(session.loadedId, String(i));
  }
  assert.equal(reads, 8);
  assert.ok(session.localLoaded.length <= 6);
  out.audio.dispatchEvent(new Event('ended'));
  assert.equal(state.playing, false);
  assert.equal(out.intent, false);
});
