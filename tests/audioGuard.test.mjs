import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAudioGuardState, installAudioGuard, outputDevices, outputDisappeared } from '../public/audioGuard.js';

test('transient resumes once within five minutes; repeated loss does not extend deadline', () => {
  let now = 0;
  const s = createAudioGuardState({ clock: () => now });
  assert.equal(s.decide('lossTransient', true), 'pause');
  assert.equal(s.blocked, true);
  now = 200000;
  s.decide('lossTransient', false);
  assert.equal(s.decide('gain', false), 'resume');
  assert.equal(s.blocked, false);
  assert.equal(s.decide('gain', false), 'restore');
  s.decide('lossTransient', true);
  now += 300000;
  assert.equal(s.waiting, false);
  assert.equal(s.decide('gain', false), 'restore');
  assert.equal(s.blocked, true);
});

test('user actions, disabled setting, permanent loss and disconnect cancel resume', () => {
  for (const cancel of ['interact', 'loss', 'becomingNoisy', 'browserPause']) {
    const s = createAudioGuardState();
    s.decide('lossTransient', true);
    if (cancel === 'interact') s.interact(); else s.decide(cancel, false);
    assert.equal(s.decide('gain', false), 'restore', cancel);
  }
  let enabled = false;
  const s = createAudioGuardState({ autoResume: () => enabled });
  s.decide('lossTransient', true);
  assert.equal(s.decide('gain', false), 'restore');
  enabled = true; s.interact(); s.decide('lossTransient', true); enabled = false;
  assert.equal(s.decide('gain', false), 'restore');
  assert.equal(createAudioGuardState().decide('lossTransient', false), 'none');
});

test('duck is idempotent, never pauses, and restores on gain/loss/interaction', () => {
  const s = createAudioGuardState();
  assert.equal(s.decide('lossTransientCanDuck', true), 'duck');
  assert.equal(s.ducked, true);
  s.decide('lossTransientCanDuck', true);
  assert.equal(s.decide('gain', true), 'restore');
  assert.equal(s.ducked, false);
  s.decide('lossTransientCanDuck', true); s.interact();
  assert.equal(s.ducked, false);
  s.decide('lossTransientCanDuck', true); s.decide('loss', true);
  assert.equal(s.ducked, false);
});

test('only identifiable audio outputs count; disappearance versus addition', () => {
  const device = (deviceId, label = '耳机', kind = 'audiooutput') => ({ deviceId, label, kind });
  const before = outputDevices([device('headphones'), device('default'), device('hidden', ''), device('mic', 'mic', 'audioinput')]);
  assert.deepEqual([...before], ['headphones']);
  assert.equal(outputDisappeared(undefined, before), false);
  assert.equal(outputDisappeared(before, outputDevices([device('headphones'), device('speaker')])), false);
  assert.equal(outputDisappeared(before, new Set()), true);
});

const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(extra = {}) {
  const audio = Object.assign(new EventTarget(), { paused: false, ended: false });
  let playing = true, pauses = [], resumes = 0, volume;
  const guard = installAudioGuard({ audio, isPlaying: () => playing,
    pause: reason => { pauses.push(reason); playing = false; audio.paused = true; audio.dispatchEvent(new Event('pause')); },
    resume: () => { resumes++; playing = true; audio.paused = false; audio.dispatchEvent(new Event('play')); },
    setDucking: factor => { volume = factor; }, publish() {}, capacitor: null, navigator: null, ...extra });
  return { audio, guard, pauses, get resumes() { return resumes; }, get volume() { return volume; } };
}

test('bridge handles absent APIs and browser OS pauses without recursive pauses', () => {
  const h = harness();
  h.audio.paused = true; h.audio.dispatchEvent(new Event('pause'));
  assert.deepEqual(h.pauses, ['browserPause']);
  assert.equal(h.guard.blocked, true);
  h.guard.event('gain'); assert.equal(h.resumes, 0);
  h.guard.dispose();
});

test('native listeners precede focus; transient retains focus; user pause abandons', async () => {
  const listeners = {}, calls = [];
  const h = harness({ capacitor: { isNativePlatform: () => true }, nativePlugin: name => {
    assert.equal(name, 'AudioGuard');
    return { addListener: async (event, fn) => { listeners[event] = fn; calls.push(event); return { remove() {} }; },
      requestFocus: async () => { calls.push('request'); return { granted: true }; },
      abandonFocus: async () => { calls.push('abandon'); } };
  } });
  h.audio.dispatchEvent(new Event('play')); await flush();
  assert.deepEqual(calls, ['becomingNoisy', 'focusChange', 'request']);
  listeners.focusChange({ state: 'lossTransientCanDuck' }); assert.equal(h.volume, 0.3);
  listeners.focusChange({ state: 'gain' }); assert.equal(h.volume, 1);
  listeners.focusChange({ state: 'lossTransient' }); await flush();
  assert.deepEqual(h.pauses, ['lossTransient']); assert.equal(h.guard.waiting, true);
  assert.equal(calls.includes('abandon'), false);
  listeners.focusChange({ state: 'gain' }); await flush();
  assert.equal(h.resumes, 1);
  listeners.focusChange({ state: 'lossTransient' }); h.guard.interact(); await flush();
  assert.equal(calls.includes('abandon'), true);
  listeners.focusChange({ state: 'gain' }); assert.equal(h.resumes, 1);
  h.guard.dispose();
});

test('web devicechange pauses on removed output, tolerates denied enumeration', async () => {
  let list = [{ kind: 'audiooutput', label: '蓝牙耳机', deviceId: 'bt' }];
  const devices = Object.assign(new EventTarget(), { enumerateDevices: async () => list });
  const h = harness({ navigator: { mediaDevices: devices } });
  await flush();
  list = [{ kind: 'audiooutput', label: '', deviceId: '' }];
  devices.dispatchEvent(new Event('devicechange')); await flush();
  assert.equal(h.pauses.length, 0);
  list = [{ kind: 'audiooutput', label: '蓝牙耳机', deviceId: 'bt' }];
  devices.dispatchEvent(new Event('devicechange')); await flush();
  list = []; devices.dispatchEvent(new Event('devicechange')); await flush();
  assert.deepEqual(h.pauses, ['becomingNoisy']);
  devices.enumerateDevices = async () => { throw Error('denied'); };
  devices.dispatchEvent(new Event('devicechange')); await flush();
  h.guard.dispose();
});

const dashboard = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
function sessionHarness(guest) {
  const audio = Object.assign(new EventTarget(), { paused: false, currentTime: 40, duration: 120, readyState: 4 });
  const state = { playing: true, volume: 0.8, duration: 120, loaded: true, role: guest ? 'guest' : 'host', library: [{ id: 'track' }], currentId: 'track' };
  const messages = [], toasts = [];
  const out = { audio, intent: true, appPauses: 0, pausedAt: 0, unlock() {}, setVolume() {}, position: () => audio.currentTime,
    stopAt(at, pos) { this.intent = false; this.pausedAt = pos; audio.currentTime = pos;
      if (!audio.paused) { this.appPauses++; audio.paused = true; audio.dispatchEvent(new Event('pause')); } },
    playAt(at, pos) { this.intent = true; audio.currentTime = pos; audio.paused = false; audio.dispatchEvent(new Event('play')); } };
  const context = vm.createContext({ audioGuard: null, audioDuck: 1, installAudioGuard, window: {},
    nativePlugin() { assert.fail('web must not use native APIs'); }, stored: () => '',
    get: () => state, set: patch => Object.assign(state, patch), toast: text => toasts.push(text),
    now: () => 1000, queueMicrotask: fn => fn(), updateMediaPosition() {}, console });
  const start = dashboard.indexOf('class Session {');
  const end = dashboard.indexOf('const session = new Session();', start);
  const Session = vm.runInContext(`${dashboard.slice(start, end)}; Session`, context);
  const session = Object.assign(Object.create(Session.prototype), { out, loadedId: 'track', anchor: { trackId: 'track', playing: true, position: 40, at: 1000 },
    conn: { open: true }, peerRtt: 20, forceResync: false, clock: { toLocal: x => x, toHost: x => x, ready: true }, drift: { reset() {} },
    send: m => messages.push(m), notifySynced() {}, noteAction() {} });
  context.session = session;
  const bridgeStart = dashboard.indexOf('audioGuard = installAudioGuard({');
  vm.runInContext(dashboard.slice(bridgeStart, dashboard.indexOf('\nobserveAudio', bridgeStart)), context);
  return { session, state, messages, toasts, guard: context.audioGuard };
}

test('guest disconnect pauses locally, host broadcasts aligned pause, manual replay uses existing anchors', async () => {
  const host = sessionHarness(false), guest = sessionHarness(true);
  guest.guard.event('becomingNoisy');
  assert.equal(guest.session.out.intent, false);
  assert.equal(guest.state.playing, false);
  assert.equal(guest.toasts[0], '耳机已断开，已暂停播放');
  assert.equal(guest.messages[0].type, 'audio-guard-pause');
  host.session.onMessage(guest.messages.shift());
  assert.equal(host.toasts[0], '对方耳机已断开，已自动暂停');
  const pause = host.messages.shift();
  assert.equal(pause.type, 'pause');
  guest.session.onMessage(pause);
  assert.equal(host.session.out.intent, false);
  assert.equal(guest.session.out.pausedAt, host.session.out.pausedAt);
  // Stale playing heartbeats cannot restart the disconnected guest.
  guest.session.onState({ ...pause, playing: true });
  assert.equal(guest.session.out.intent, false);
  guest.session.act('play');
  host.session.onMessage(guest.messages.shift());
  const play = host.messages.shift();
  guest.session.onMessage(play);
  assert.equal(host.session.out.intent, true);
  assert.equal(guest.session.out.intent, true);
  assert.equal(host.session.out.audio.currentTime, guest.session.out.audio.currentTime);
  host.guard.dispose(); guest.guard.dispose(); await flush();
});

test('host transient pause broadcasts normally; gain resumes both; peer manual pause cancels guest resume', async () => {
  const host = sessionHarness(false), guest = sessionHarness(true);
  host.guard.event('lossTransient');
  assert.equal(host.state.audioFocusTransient, true);
  guest.session.onMessage(host.messages.shift());
  assert.equal(guest.session.out.intent, false);
  host.guard.event('gain');
  guest.session.onMessage(host.messages.shift());
  assert.equal(guest.session.out.intent, true);
  assert.equal(host.session.out.audio.currentTime, guest.session.out.audio.currentTime);
  guest.guard.event('lossTransient');
  host.session.onMessage(guest.messages.shift());
  guest.session.onMessage(host.messages.shift());
  assert.equal(guest.guard.waiting, true);
  guest.session.onMessage({ type: 'pause', by: 'host', trackId: 'track', playing: false, position: 41, at: 1000 });
  assert.equal(guest.guard.waiting, false);
  guest.guard.event('gain');
  assert.equal(guest.messages.length, 0);
  assert.equal(host.toasts.at(-1), '对方正在处理其他音频，已自动暂停');
  host.guard.dispose(); guest.guard.dispose(); await flush();
});

test('transient focus pause retains an already running foreground service until canceled', async () => {
  const calls = [], listeners = [];
  const state = { playing: true, library: [{ id: 'track' }], currentId: 'track' };
  const session = { out: { intent: true } };
  const start = dashboard.indexOf('if (NativeFG) {');
  const end = dashboard.indexOf('\nfunction fromLocal', start);
  vm.runInNewContext(dashboard.slice(start, end), {
    NativeFG: new Proxy({}, { get: (_, name) => async () => calls.push(name) }), get: () => state, session, console, toast() {},
    document: { hidden: true, addEventListener() {} }, store: { subscribe: fn => listeners.push(fn) },
  });
  const publish = patch => { Object.assign(state, patch); listeners.forEach(fn => fn()); };
  publish({}); await flush();
  session.out.intent = false; publish({ playing: false, audioFocusTransient: true }); await flush();
  assert.equal(calls.includes('stopForegroundService'), false);
  session.out.intent = true; publish({ playing: true, audioFocusTransient: false }); await flush();
  assert.equal(calls.filter(x => x === 'startForegroundService').length, 1);
  session.out.intent = false; publish({ playing: false }); await flush();
  assert.equal(calls.filter(x => x === 'stopForegroundService').length, 1);
});
