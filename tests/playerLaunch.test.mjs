import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import htm from 'htm';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const between = (start, end) => {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0 && source.indexOf(end, offset) > offset);
  return source.slice(offset, source.indexOf(end, offset));
};

function harness() {
  // Exercise the real initial state even with an old selection in storage.
  const state = vm.runInNewContext(`${between('const store = createStore(', 'const useStore =')}; store`, {
    createStore: value => value, loadProfile: () => ({ name: 'Listener' }), MOCK_SOURCES: [], ALL_ID: 'all',
    localStorage: { getItem: key => key === 'hh.currentId' ? 'previous-track' : null },
  });
  const track = { id: 'song', hash: 'hash', title: 'Song', artist: 'Artist', duration: 100 };
  const context = {
    get: () => state, set: patch => Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
    LocalLib: { listTracks: async () => [track], coverUrl: async () => null },
    playlistStore: { load: async () => {} }, fromLocal: t => t,
    refreshOffline: async () => {}, repairLibraryCovers() {}, now: () => 0, clearTimeout, console,
    html: htm.bind(React.createElement), useStore: fn => fn(state),
    useState: () => [0, () => {}], useRef: () => ({ current: null }), useBackLayer() {}, useEffect() {},
    cx: (...args) => args.filter(Boolean).join(' '),
    ...Object.fromEntries(['Cover', 'CoListenPill', 'Pause', 'Play', 'SkipForward'].map(name => [name, () => null])),
  };
  const methods = vm.runInNewContext(`({
    ${between('  async restoreLocal()', '\n  leave()')},
    ${between('  act(action,', '\n  transport(')},
    ${between('  async loadTrack(', '\n  startAutoplay()')},
    ${between('  async addToLibrary(', '\n  async importFiles(')}
  })`, context);
  const session = {
    ...methods, isGuest: false, token: 0, sendGen: 0, blobs: new Map([[track.id, {}]]),
    broadcastLibrary() {}, send() {}, syncQueue: () => ({ moveTo() {} }),
    out: { unlock() {}, intent: true, audio: { paused: false }, load: async () => 100 },
  };
  context.session = session;
  const Player = vm.runInNewContext(`${between('function NativePlayer(', '\nfunction App()')}; NativePlayer`, context);
  const render = () => renderToStaticMarkup(React.createElement(Player, { open: false }));
  return { state, track, session, render, context };
}

test('non-empty restored library stays unselected until a play action, then remains visible while paused', async () => {
  const { state, track, session, render } = harness();
  assert.equal(state.currentId, null);
  await session.restoreLocal();
  assert.equal(state.library.length, 1);
  assert.equal(state.currentId, null);
  assert.equal(render(), '');
  await session.act('next');
  assert.equal(state.currentId, null);
  await session.act('select', { itemId: track.id });
  assert.equal(state.currentId, track.id);
  assert.equal(state.playing, true);
  assert.match(render(), /class="mini-player /);
  state.playing = false;
  assert.match(render(), /class="mini-player /);
});

test('adding the first download or import does not select it', async () => {
  const { state, track, session, render } = harness();
  await session.addToLibrary({ size: 10, type: 'audio/mpeg' }, track);
  assert.equal(state.library.length, 1);
  assert.equal(state.currentId, null);
  assert.equal(render(), '');
});

test('missing selected item stays hidden; co-listen guests see host metadata before audio loads', () => {
  const { state, track, render } = harness();
  state.currentId = 'missing';
  state.loaded = true;
  assert.equal(render(), '');
  state.role = 'guest';
  state.conn = 'open';
  state.loaded = false;
  assert.match(render(), /class="mini-player /);
  state.library = [track];
  state.currentId = track.id;
  assert.match(render(), /Song/);
  assert.match(render(), /class="mini-player /);
});

test('page reserves mini-player space only while a track or co-listen session is present', () => {
  const { state, track, context } = harness();
  const visible = () => vm.runInNewContext(`(() => { ${between('  const playerVisible =', '\n  useEffect(')}; return playerVisible; })()`, context);
  const padding = keyboardOpen => vm.runInNewContext(
    between('    <main class="mx-auto max-w-5xl', '\n      ${tab').match(/paddingBottom: (.*) \}\}>/)[1],
    { keyboardOpen, playerVisible: visible() },
  );
  assert.match(padding(false), /80px/);
  state.library = [track]; state.currentId = track.id;
  assert.match(padding(false), /170px/);
  assert.match(padding(true), /16px/);
});

test('desktop controls tolerate a missing track and disable play and next even with stale loaded flags', () => {
  const { state, context } = harness();
  Object.assign(state, { loaded: true, canNext: true });
  for (const name of ['LinkIndicator', 'MiniWave', 'PlayModeButton', 'SkipBack', 'ListMusic', 'SeekBar', 'Volume2', 'VolumeX', 'SyncStatus']) {
    context[name] = () => null;
  }
  const PlayerBar = vm.runInNewContext(`${between('function PlayerBar()', '\nfunction Toasts()')}; PlayerBar`, context);
  const markup = renderToStaticMarkup(React.createElement(PlayerBar));
  const controls = [...markup.matchAll(/<button[^>]*>/g)].filter(([tag]) => /aria-label="(?:\u64ad\u653e|\u4e0b\u4e00\u9996)"/.test(tag));
  assert.equal(controls.length, 2);
  for (const [tag] of controls) assert.match(tag, /disabled=""/);
});
