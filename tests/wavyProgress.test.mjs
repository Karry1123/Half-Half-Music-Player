import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import React from 'react';
import htm from 'htm';
const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function wavePath('), source.indexOf('function SeekBar('));
const wavePath = vm.runInNewContext(`${code}; wavePath`);
const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : [];
function harness(overrides = {}) {
  const effects = [], updates = [], frames = new Map(), documentEvents = new Map(), mediaEvents = new Map(), paths = [];
  let nextFrame = 0, measuredWidth = 320, resize;
  const doc = { visibilityState: 'visible', addEventListener: (key, fn) => documentEvents.set(key, fn), removeEventListener: key => documentEvents.delete(key) };
  const media = { matches: false, addEventListener: (key, fn) => mediaEvents.set(key, fn), removeEventListener: key => mediaEvents.delete(key) };
  const Component = vm.runInNewContext(`${code}; WavyProgress`, {
    useRef: initial => ({ current: initial === null ? { getBoundingClientRect: () => ({ width: measuredWidth }), setAttribute: (_, d) => paths.push(d) } : initial }),
    useState: initial => [initial === 0 ? 320 : initial, value => updates.push(value)], useId: () => ':test:', useEffect: fn => effects.push(fn),
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} disconnect() {} },
    document: doc, window: { matchMedia: () => media },
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id),
    html: htm.bind(React.createElement),
  });
  const tree = Component({ value: 50, duration: 100, playing: true, dragging: false, open: true, ...overrides });
  const cleanups = effects.map(fn => fn());
  return { tree, frames, updates, paths, doc, media, documentEvents, mediaEvents,
    tick: time => { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(time); },
    resize: width => { measuredWidth = width; resize(); }, cleanup: () => cleanups.forEach(fn => fn()) };
}
test('wave is bounded to track endpoints with 3px amplitude and 20px wavelength', () => {
  const points = wavePath(314).match(/[ML][\d.]+,[\d.]+/g).map(p => p.slice(1).split(',').map(Number));
  assert.equal(points[0][0], 7); assert.equal(points.at(-1)[0], 307);
  for (const [x, y] of points) { assert.ok(x >= 7 && x <= 307); assert.ok(y >= 19 && y <= 25); }
  assert.equal(points[0][1], points[10][1]);
});
test('clip and thumb follow progress, clamp endpoints, and disappear for unknown duration', () => {
  for (const [value, duration, expected] of [[50,100,160],[-10,100,7],[200,100,313],[NaN,100,7]]) {
    const h = harness({ value, duration }), nodes = flatten(h.tree);
    assert.equal(nodes.find(n => n.type === 'circle').props.cx, expected);
    assert.equal(nodes.find(n => n.type === 'rect').props.width, expected);
    h.cleanup();
  }
  for (const duration of [0, undefined, NaN, Infinity]) {
    const h = harness({ duration }), nodes = flatten(h.tree);
    assert.equal(nodes.some(n => n.type === 'circle'), false);
    assert.equal(nodes.some(n => n.type === 'path'), false);
    assert.equal(h.frames.size, 0); h.cleanup();
  }
});
test('phase runs only during visible active playback and stops on hide, reduced motion and cleanup', () => {
  const h = harness(); assert.equal(h.frames.size, 1);
  h.tick(100); h.tick(116); assert.notEqual(h.paths[0], h.paths[1]);
  h.doc.visibilityState = 'hidden'; h.documentEvents.get('visibilitychange')();
  assert.equal(h.frames.size, 0); assert.equal(h.updates.at(-1), false);
  h.doc.visibilityState = 'visible'; h.documentEvents.get('visibilitychange')(); assert.equal(h.frames.size, 1);
  h.media.matches = true; h.mediaEvents.get('change')(); assert.equal(h.frames.size, 0);
  h.media.matches = false; h.mediaEvents.get('change')(); assert.equal(h.frames.size, 1);
  h.resize(412); assert.equal(h.updates.at(-1), 412);
  h.cleanup(); assert.equal(h.frames.size, 0); assert.equal(h.documentEvents.size, 0); assert.equal(h.mediaEvents.size, 0);
  for (const options of [{ playing: false }, { dragging: true }, { open: false }]) {
    const stopped = harness(options); assert.equal(stopped.frames.size, 0); assert.equal(stopped.updates.at(-1), false); stopped.cleanup();
  }
});
