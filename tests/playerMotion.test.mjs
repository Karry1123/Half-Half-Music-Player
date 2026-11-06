import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import React from 'react';
import htm from 'htm';
const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function NativePlayer('), source.indexOf('function App()'));
const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : [];
function harness({ reduced = false, queueOpen = false, lyricsOpen = false } = {}) {
  const state = { library: [{ id: 'a', title: 'Song' }], currentId: 'a', playlists: [], playMode: 'order', loaded: true };
  const effects = [], events = new Map(), timers = new Map(), changes = [];
  let timerId = 0, closed = 0, collapseFocused = 0, miniFocused = 0;
  const slots = [150, queueOpen, null, 'dark', lyricsOpen];
  const collapse = { focus: () => collapseFocused++ };
  const panel = { contains: () => true };
  const doc = { body: { style: {} }, documentElement: { style: {}, dataset: { theme: 'dark' } },
    querySelector: selector => selector.includes('收起播放器') ? collapse : panel,
    addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) };
  const Component = vm.runInNewContext(`${code}; NativePlayer`, {
    html: htm.bind(React.createElement), useStore: fn => fn(state),
    useState: () => { const i = 5 - slots.length; return [slots.shift(), value => changes.push([i, value])]; },
    useRef: value => ({ current: value }), useEffect: fn => effects.push(fn), useBackLayer() {},
    document: doc, window: { innerHeight: 640, matchMedia: () => ({ matches: reduced }) },
    MutationObserver: class { observe() {} disconnect() {} }, loadCoverPalette: async () => null,
    getComputedStyle: () => ({ getPropertyValue: () => '240ms' }),
    clearTimeout: id => timers.delete(id), setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    coverCandidates: () => [], cx: (...args) => args.filter(Boolean).join(' '), get: () => state, set: patch => Object.assign(state, patch), session: {}, trackCompletedCount: () => 0,
    ...Object.fromEntries(['FileText','Cover','CoListenPill','Pause','Play','SkipForward','ChevronDown','ListMusic','SeekBar','SkipBack','Shuffle','Repeat','Repeat1','Heart','SyncStatus','Volume2','VolumeX','VolumeSlider','PlayerQueueDrawer','LyricsSheet'].map(name => [name, () => null])),
  });
  const tree = Component({ open: true, close: () => closed++, expand() {} }), nodes = flatten(tree);
  nodes.find(n => n.type === 'button' && n.props['aria-label'] === '展开播放器').ref.current = { focus: () => miniFocused++ };
  const cleanups = effects.map(fn => fn());
  const player = nodes.find(n => n.props?.class?.startsWith('fullscreen-player'));
  return { state, events, timers, changes, player, closed: () => closed, collapseFocused: () => collapseFocused, miniFocused: () => miniFocused,
    cleanup: () => cleanups.forEach(fn => fn?.()) };
}
test('swipe closes once on its own transform transitionend; fallback uses the motion token', () => {
  const h = harness();
  h.player.props.onTouchEnd();
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 300);
  const target = {};
  h.player.props.onTransitionEnd({ target, currentTarget: target, propertyName: 'background-color' });
  h.player.props.onTransitionEnd({ target: {}, currentTarget: target, propertyName: 'transform' });
  assert.equal(h.closed(), 0);
  h.player.props.onTransitionEnd({ target, currentTarget: target, propertyName: 'transform' });
  h.player.props.onTransitionEnd({ target, currentTarget: target, propertyName: 'transform' });
  assert.equal(h.closed(), 1); assert.equal(h.timers.size, 0); h.cleanup();
  const fallback = harness(); fallback.player.props.onTouchEnd(); [...fallback.timers.values()][0].fn();
  assert.equal(fallback.closed(), 1); fallback.cleanup();
});
test('open focuses collapse, close restores mini expand, reduced motion closes without waiting', () => {
  const h = harness({ reduced: true });
  assert.equal(h.collapseFocused(), 1);
  h.player.props.onTouchEnd(); assert.equal(h.closed(), 1); assert.equal(h.timers.size, 0);
  h.cleanup(); assert.equal(h.miniFocused(), 1); assert.equal(h.events.size, 0);
});
test('Escape dismisses the queue before the player, including when focus is outside the queue', () => {
  const queue = harness({ queueOpen: true });
  queue.events.get('keydown')({ key: 'Escape' });
  assert.equal(queue.closed(), 0); assert.deepEqual(queue.changes.at(-1), [1, false]); queue.cleanup();
  const player = harness(); player.events.get('keydown')({ key: 'Escape' });
  assert.equal(player.closed(), 1); player.cleanup();
});

test('Escape closes lyrics before the player; hidden main progress stops its wave', () => {
  const h = harness({ lyricsOpen: true });
  h.events.get('keydown')({ key: 'Escape' });
  assert.equal(h.closed(), 0); assert.deepEqual(h.changes.at(-1), [4, false]);
  const nodes = flatten(h.player);
  const main = nodes.find(node => node.props?.class?.startsWith('fsp-main'));
  assert.equal(main.props.hidden, true);
  const seek = nodes.find(node => node.props?.stacked === true);
  assert.equal(seek.props.open, false);
  h.cleanup();
});
