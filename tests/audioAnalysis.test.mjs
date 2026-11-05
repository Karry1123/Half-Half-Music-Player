import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { analyseTrack, gainFor, trimBounds, createAnalysisQueue } from '../public/audioAnalysis.js';

function buffer(db = 0, rate = 48000, silent = false) {
  const data = new Float32Array(rate * 5);
  if (!silent) for (let i = rate; i < rate * 4; i++) data[i] = 0.25 * 10 ** (db / 20) * Math.sin(2 * Math.PI * 1000 * i / rate);
  return { sampleRate: rate, numberOfChannels: 1, length: data.length, getChannelData: () => data };
}
const analyse = audio => analyseTrack(new Blob(['audio']), { decode: async () => audio });

test('20 ms silence windows, peak and gated K-weighted loudness across sample rates', async () => {
  for (const rate of [32000, 44100, 48000, 96000]) {
    const loud = await analyse(buffer(0, rate)), quiet = await analyse(buffer(-6, rate));
    assert.ok(Math.abs(loud.leadIn - 1) < 0.021);
    assert.ok(Math.abs(loud.trailOut - 1) < 0.021);
    assert.ok(Math.abs(loud.loudness - quiet.loudness - 6) < 0.05);
    assert.ok(Math.abs(loud.peak - 20 * Math.log10(0.25)) < 0.05);
    assert.equal(loud.duration, 5); assert.equal(loud.version, 1);
    assert.ok(Math.abs(loud.loudness - (-15.1)) < 0.5);
  }
});

test('gain attenuates loud tracks and obeys desktop/Android boost caps', () => {
  assert.ok(Math.abs(gainFor(-10, { maxBoost: 6 }) - 10 ** (-6 / 20)) < 1e-10);
  assert.ok(Math.abs(gainFor(-30, { maxBoost: 6 }) - 10 ** (6 / 20)) < 1e-10);
  assert.equal(gainFor(-30, { maxBoost: 0 }), 1);
  assert.equal(gainFor(null, { maxBoost: 6 }), 1);
  assert.equal(gainFor(-120, { maxBoost: 6 }), 1);
});

test('trim caps leading/trailing silence and combined trim at 20%; silence survives JSON', async () => {
  assert.deepEqual(trimBounds({ version: 1, leadIn: 25, trailOut: 90 }, 500), { start: 15, end: 440 });
  assert.deepEqual(trimBounds({ version: 1, leadIn: 10, trailOut: 50 }, 100), { start: 10, end: 90 });
  assert.deepEqual(trimBounds(null, 100), { start: 0, end: 100 });
  const silent = JSON.parse(JSON.stringify(await analyse(buffer(0, 48000, true))));
  assert.deepEqual(trimBounds(silent, 5), { start: 0, end: 5 });
  assert.equal(gainFor(silent.loudness, { maxBoost: 6 }), 1);
});

const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
function outputHarness(android = false) {
  class Audio {
    listeners = new Map(); paused = false; currentTime = 0; playbackRate = 1; volume = 1;
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    emit(name) { this.listeners.get(name)?.(); }
    pause() { this.paused = true; this.emit('pause'); }
  }
  let timer, delay;
  const code = source.slice(source.indexOf('class AudioOut {'), source.indexOf('class Session {'));
  const Out = vm.runInNewContext(`${code}; AudioOut`, {
    Audio, audioDuck: 0.5, isAndroid: android, get: () => ({ volume: 0.8 }), stored: () => null,
    gainFor, setTimeout: (fn, ms) => { timer = fn; delay = ms; return 1; }, clearTimeout: () => { timer = null; },
  });
  return { out: new Out(), fireTimer: () => timer?.(), delay: () => delay };
}

test('end trim uses media time and a precise timer, calls onEnded once despite late events', () => {
  const h = outputHarness(), out = h.out;
  let ended = 0; out.onEnded = () => ended++; out.intent = true;
  out.audio.currentTime = 8;
  out.setEndBoundary(9);
  assert.ok(Math.abs(h.delay() - 950) < 0.001);
  out.audio.currentTime = 8.96; h.fireTimer();
  out.audio.emit('timeupdate'); out.audio.emit('ended');
  assert.equal(ended, 1); assert.equal(out.audio.paused, true);
});

test('end timer cancels on pause/waiting and rearms after seeking or playback', () => {
  const h = outputHarness(), out = h.out;
  let ended = 0; out.onEnded = () => ended++; out.intent = true;
  out.setEndBoundary(9); out.audio.pause(); out.audio.currentTime = 9; h.fireTimer();
  assert.equal(ended, 0);
  out.audio.currentTime = 2; out.audio.paused = false; out.audio.emit('playing');
  out.audio.emit('waiting'); h.fireTimer(); assert.equal(ended, 0);
  out.audio.currentTime = 9; out.audio.emit('seeked'); assert.equal(ended, 1);
});

test('output multiplies volume, duck and track gain; plain media never boosts', () => {
  const { out } = outputHarness(true);
  out.setTrackGain(2); assert.equal(out.audio.volume, 0.4);
  out.setTrackGain(0.5); assert.equal(out.audio.volume, 0.2);
  let gain;
  out.ctx = { currentTime: 0 }; out.gain = { gain: { setTargetAtTime: v => { gain = v; } } };
  out.setTrackGain(2); assert.equal(gain, 0.8);
});

test('analysis queue serializes, prioritizes playing blobs, pauses for transfers and skips analysed/guest tracks', async () => {
  const library = new Map(['a', 'b', 'done', 'guest'].map(id => [id, { id, localId: id === 'guest' ? null : id, ...(id === 'done' && { analysis: { version: 1 } }) }]));
  const idle = [], releases = [], order = [], saved = [];
  let allowed = false, active = 0, maxActive = 0;
  const queue = createAnalysisQueue({
    lookup: id => library.get(id), eligible: item => !!item?.localId,
    canRun: () => allowed, idle: fn => idle.push(fn), retry: fn => idle.push(fn), read: async id => id,
    analyse: async blob => { order.push(blob); maxActive = Math.max(maxActive, ++active); await new Promise(resolve => releases.push(resolve)); active--; return { version: 1 }; },
    persist: async (id, analysis) => saved.push([id, analysis]), apply: (id, analysis) => { library.get(id).analysis = analysis; },
  });
  queue.enqueue('a'); queue.enqueue('b', 'playing'); queue.enqueue('done'); queue.enqueue('guest');
  assert.deepEqual(order, []);
  allowed = true;
  const work = idle.shift()(); await Promise.resolve();
  assert.deepEqual(order, ['playing']); queue.enqueue('b', 'duplicate');
  releases.shift()(); await work;
  while (idle.length) {
    const next = idle.shift()(); await Promise.resolve(); await Promise.resolve();
    releases.shift()?.(); await next;
  }
  assert.equal(maxActive, 1); assert.deepEqual(order, ['playing', 'a']);
  assert.deepEqual(saved.map(([id]) => id), ['b', 'a']);
});

test('fresh solo autoplay seeks to lead-in and anchors real position; rooms and resumes retain their offsets', async () => {
  for (const [connected, resumeAt, expected] of [[false, null, 2], [true, null, 0], [false, 17, 17]]) {
    const analysis = { version: 1, leadIn: 2, trailOut: 4, duration: 100, loudness: -20 };
    const state = { library: [{ id: 'song', localId: 'local', duration: 100, analysis }], peerReady: true };
    const begin = source.indexOf('  async loadTrack('), end = source.indexOf('\n  startAutoplay()', begin);
    const methods = vm.runInNewContext(`({${source.slice(begin, end)}})`, {
      trimBounds, get: () => state, now: () => 1000, clearTimeout,
      set: patch => Object.assign(state, patch),
    });
    let options, boundary, transported;
    const session = { ...methods, token: 0, sendGen: 0, blobs: new Map([['song', {}]]),
      conn: { open: connected }, send() { state.peerReady = true; }, broadcastLibrary() {},
      syncQueue: () => ({ moveTo() {} }), analysisQueue: { enqueue() {} },
      transport: (_, position) => { transported = position; },
      out: { intent: true, audio: { paused: false }, stopAt() {},
        load: async (_, opts) => { options = opts; return 100; }, setEndBoundary: end => { boundary = end; } },
    };
    await session.loadTrack('song', { autoplay: true, resumeAt });
    assert.equal(options.position, expected);
    assert.equal(session.anchor.position, expected);
    assert.equal(boundary, 96);
    assert.equal(options.analysis, analysis);
    if (connected || resumeAt !== null) assert.equal(transported, expected);
    else assert.equal(options.autoplay, true);
  }
});

test('guest loading applies normalization metadata without trim offsets or boundaries', async () => {
  const analysis = { version: 1, leadIn: 2, trailOut: 4 };
  const state = { library: [{ id: 'song', analysis }] };
  const begin = source.indexOf('  async guestLoad('), end = source.indexOf('\n  /**', begin);
  const methods = vm.runInNewContext(`({${source.slice(begin, end)}})`, {
    get: () => state, set: patch => Object.assign(state, patch),
  });
  let options;
  const session = { ...methods, token: 1, anchor: {}, send() {}, prefetchNext() {},
    out: { load: async (_, opts) => { options = opts; return 100; } },
  };
  await session.guestLoad('song', {}, 1);
  assert.equal(options.analysis, analysis);
  assert.equal(options.end, undefined); assert.equal(options.position, undefined);
});
