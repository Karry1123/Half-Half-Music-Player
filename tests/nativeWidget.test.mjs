import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installNativePlayback, snapshot } from '../public/nativePlayback.js';
import { PLAY_MODES } from '../public/playQueue.js';

const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function harness(extra = {}) {
  const updates = [], actions = [], listeners = [];
  const state = { library: [{ id: 'a', localId: 'local-a', title: 'A', cover: 'a.jpg' }], currentId: 'a', playlists: [], playMode: 'order', role: 'solo' };
  let receive;
  const session = { out: {}, position: () => 0, act: a => actions.push(a) };
  const bridge = installNativePlayback({
    plugin: { update: async s => updates.push(s), setArtwork: async () => {}, requestNotifications: async () => {}, addListener: async (_, fn) => { receive = fn; } },
    store: { subscribe: fn => listeners.push(fn) }, get: () => state, session,
    fetchCover: async () => null, fallbackArtwork: () => 'data:image/png;base64,AA==',
    doc: { hidden: true, addEventListener() {}, removeEventListener() {} }, ...extra,
  });
  return { state, updates, actions, bridge, receive: action => receive({ action }), publish: patch => { Object.assign(state, patch); listeners.forEach(fn => fn()); } };
}

test('native snapshot validates new fields and resolves favorites through local track IDs', () => {
  const item = { id: 'remote', localId: 'saved' }, session = { position: () => 0 };
  const state = { playlists: [{ id: 'favorites', trackIds: ['saved'] }], playMode: 'loopOne', role: 'guest' };
  const s = snapshot(state, session, item, '#AABBCC');
  assert.equal(s.favorite, true); assert.equal(s.playMode, 'loopOne');
  assert.equal(s.canChangeMode, false); assert.equal(s.seedColor, '#aabbcc');
  const old = snapshot({}, session, item, 'rgb(1, 2, 3)');
  assert.equal(old.favorite, false); assert.equal(old.playMode, 'order'); assert.equal(old.seedColor, '');
  assert.equal(snapshot(state, session, null, '#aabbcc').seedColor, '');
});

test('favorite and play mode changes republish without waiting for a playback tick', async () => {
  const h = harness(); h.bridge.markReady(); await drain();
  h.publish({ playlists: [{ id: 'favorites', trackIds: ['local-a'] }] }); await drain();
  assert.equal(h.updates.at(-1).favorite, true);
  h.publish({ playMode: 'shuffle', role: 'guest' }); await drain();
  assert.equal(h.updates.at(-1).playMode, 'shuffle'); assert.equal(h.updates.at(-1).canChangeMode, false);
});

test('late palettes cannot tint a different track or an updated cover', async () => {
  const pending = new Map();
  const h = harness({ getSeedColor: item => new Promise(resolve => pending.set(item.cover, resolve)) });
  h.bridge.markReady(); await drain();
  h.publish({ currentId: 'b', library: [{ id: 'b', title: 'B', cover: 'b.jpg' }] }); await drain();
  pending.get('a.jpg')('#ff0000'); await drain();
  assert.equal(h.updates.at(-1).seedColor, '');
  pending.get('b.jpg')('#00ff00'); await drain(); assert.equal(h.updates.at(-1).seedColor, '#00ff00');
  h.publish({ library: [{ id: 'b', title: 'B', cover: 'new.jpg' }] }); await drain();
  assert.equal(h.updates.at(-1).seedColor, '');
  pending.get('new.jpg')('#0000ff'); await drain(); assert.equal(h.updates.at(-1).seedColor, '#0000ff');
});

test('queued and live rapid custom taps debounce independently and wait for pending toggles', async () => {
  const custom = []; let finish;
  const h = harness({ onAction: action => { custom.push(action); return action === 'favorite' ? new Promise(r => { finish = r; }) : undefined; } });
  h.receive('favorite'); h.receive('favorite'); h.receive('mode'); h.receive('mode');
  assert.deepEqual(custom, []);
  h.bridge.markReady(); h.receive('favorite'); h.receive('mode'); await drain();
  assert.deepEqual(custom, ['favorite', 'mode']); assert.deepEqual(h.actions, []);
  finish(); h.receive('next'); assert.deepEqual(h.actions, ['next']);
});

test('dashboard widget actions cycle the single enum and reject guest mode changes', async () => {
  const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('async function handleNativeWidgetAction('), source.indexOf('const nativePlayback ='));
  const state = { library: [{ id: 'a' }], currentId: 'a', playMode: 'order', role: 'solo' };
  const favorites = [], messages = [], modes = [];
  const handle = vm.runInNewContext(`${code}; handleNativeWidgetAction`, { get: () => state, PLAY_MODES,
    toggleFavorite: async id => favorites.push(id), toast: message => messages.push(message),
    session: { setPlayMode: mode => { modes.push(mode); state.playMode = mode; } } });
  for (let i = 0; i < 4; i++) await handle('mode');
  assert.deepEqual(modes, ['loopAll', 'loopOne', 'shuffle', 'order']);
  state.role = 'guest'; await handle('mode'); assert.equal(modes.length, 4);
  assert.equal(messages[0], '\u623f\u5ba2\u4e0d\u80fd\u5207\u6362\u64ad\u653e\u6a21\u5f0f');
  await handle('favorite'); assert.deepEqual(favorites, ['a']);
});
