import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import htm from 'htm';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ring from '../public/statsRing.js';

test('ring keeps zero empty, gives tiny values a visible arc and preserves exact laps', () => {
  assert.deepEqual(ring.ringModel(0, 100), { laps: 0, fraction: 0, badge: '', arcs: [] });
  const tiny = ring.ringModel(0.3, 100);
  assert.equal(tiny.fraction, 0.003);
  assert.equal(tiny.arcs[0].fraction, 0.02);
  for (const laps of [1, 2, 5, 12, 40]) {
    const model = ring.ringModel(laps * 100, 100);
    assert.equal(model.laps, laps);
    assert.equal(model.fraction, 0);
    assert.equal(model.badge, `×${laps}`);
    assert.equal(model.arcs.length, Math.min(2, laps));
    assert.ok(model.arcs.every(arc => arc.fraction === 1));
    const tip = ring.ringTip(model.arcs.at(-1));
    assert.ok(Math.abs(tip.x - 80) < 1e-10);
    assert.equal(tip.y, 80 - ring.ringRadius);
  }
  const many = ring.ringModel(4050, 100);
  assert.equal(many.badge, '×40');
  assert.deepEqual(many.arcs.map(arc => arc.lapIndex), [38, 39, 40]);
  assert.equal(many.arcs.length, 3);
  assert.equal(ring.ringModel(-1, 100).arcs.length, 0);
  assert.equal(ring.ringModel(Infinity, 100).arcs.length, 0);
  assert.equal(ring.ringModel(20, 0).arcs.length, 0);
});

test('lap units, track, shadow and white-only tints use the card hue tokens', () => {
  assert.deepEqual(Object.values(ring.lapUnits).map(x => [x.duration / 3600, x.completed]), [[7, 50], [30, 200], [365, 2000], [1000, 5000]]);
  assert.deepEqual(ring.ringModel(2.5, 1).arcs.map(x => x.tint), [0, 18, 36]);
  assert.ok(ring.ringModel(40.5, 1).arcs.every(x => x.tint === 36));
  for (const [kind, hue] of [['duration', 'host'], ['completed', 'guest']]) {
    assert.equal(ring.lapColour(kind), `var(--color-brand-${hue})`);
    for (const tint of [18, 36]) assert.equal(ring.lapColour(kind, tint), `color-mix(in srgb, var(--color-brand-${hue}), rgb(var(--p-white-rgb)) ${tint}%)`);
    assert.equal(ring.ringHue(kind, 0.12), `rgb(var(--color-brand-${hue}-rgb) / 0.12)`);
    assert.equal(ring.ringHue(kind, 0.35), `rgb(var(--color-brand-${hue}-rgb) / 0.35)`);
  }
  assert.ok(ring.ringRadius + 20 / 2 < 80);
});

test('centre labels count whole minutes/completions and shrink to the inner width', () => {
  assert.equal(ring.formatCentre('duration', 0), '0');
  assert.equal(ring.formatCentre('completed', 0), '0');
  assert.equal(ring.formatCentre('duration', 59), '0分');
  assert.equal(ring.formatCentre('duration', 3660), '1小时1分');
  assert.equal(ring.formatCentre('duration', 2340 * 3600 + 15 * 60), '2340小时15分');
  assert.equal(ring.formatCentre('completed', 12345.9), '12,345 次');
  assert.equal(ring.centreFontSize('0'), 23);
  for (const label of ['2340小时15分', '12,345 次', '999999999999小时59分']) {
    const width = [...label].reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? 1 : 0.65), 0);
    assert.ok(ring.centreFontSize(label) * width <= 96.000001);
  }
});

const modelSource = readFileSync(new URL('../public/statsRing.js', import.meta.url), 'utf8');
function animationHarness(reduced = false) {
  let next = 0;
  const frames = new Map();
  const context = {
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame: fn => { frames.set(++next, fn); return next; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  const sweep = vm.runInNewContext(`${modelSource.replace(/^export /gm, '')}; sweep`, context);
  return { sweep, frames, tick(time) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(time)); } };
}
test('sweep runs all laps in 1200 ms, eases out, supports deltas and cancellation', () => {
  for (const target of [1, 40, 12345]) {
    const clock = animationHarness(), values = [];
    clock.sweep(0, target, 1200, x => values.push(x));
    assert.deepEqual(values, [0]);
    clock.tick(0); clock.tick(600);
    assert.equal(values.at(-1), target * 0.875);
    clock.tick(1200);
    assert.equal(values.at(-1), target);
    assert.equal(clock.frames.size, 0);
  }
  const clock = animationHarness(), values = [];
  const cancel = clock.sweep(100, 120, 1200, x => values.push(x));
  clock.tick(0); clock.tick(600);
  assert.equal(values.at(-1), 117.5);
  cancel(); clock.tick(1200);
  assert.equal(values.at(-1), 117.5);
  assert.equal(clock.frames.size, 0);
});
test('reduced motion instantly renders the target without scheduling frames', () => {
  const clock = animationHarness(true), values = [];
  clock.sweep(12, 4000, 1200, x => values.push(x));
  assert.deepEqual(values, [4000]);
  assert.equal(clock.frames.size, 0);
});

const uiSource = readFileSync(new URL('../public/statsUI.js', import.meta.url), 'utf8')
  .replace(/^\uFEFF/, '').replace(/^import .*;\r?\n/gm, '').replace('export function ListeningStatsCards', 'function ListeningStatsCards');
test('React ring has no zero tip/badge, full laps close cleanly, and many laps stay bounded', () => {
  const StatRing = vm.runInNewContext(`${uiSource}; StatRing`, {
    ...ring, React, htm, useState: value => [value, () => {}], useRef: () => ({ current: null }), useEffect() {},
  });
  const render = value => renderToStaticMarkup(React.createElement(StatRing, { value, kind: 'completed', period: 'week', label: '听完的歌' }));
  const zero = render(0);
  assert.equal((zero.match(/<circle /g) || []).length, 1);
  assert.doesNotMatch(zero, /stats-ring-tip|stats-ring-badge/);
  assert.match(zero, />0<\/text>/);
  assert.match(render(0.15), /stroke-dasharray="2 100"/);
  assert.match(render(50), /stroke-linecap="butt" stroke-dasharray="100 100"/);
  const many = render(2025);
  assert.equal((many.match(/pathLength="100"/g) || []).length, 3);
  assert.match(many, />×40<\/span>/);
});

test('live changes start at the rendered progress; switching period starts from zero', () => {
  let stored, reference = { current: null }, effect, cancel;
  const calls = [];
  const StatRing = vm.runInNewContext(`${uiSource}; StatRing`, {
    ...ring, React, htm,
    useState: initial => [stored ?? initial, next => { stored = next; }],
    useRef: () => reference, useEffect: fn => { effect = fn; },
    sweep(from, to, duration, onFrame) { calls.push([from, to, duration]); onFrame(from); cancel = onFrame; return () => {}; },
  });
  const render = (value, period) => { StatRing({ value, period, kind: 'completed', label: '听完的歌' }); effect(); };
  render(100, 'week'); cancel(60);
  render(120, 'week'); cancel(120);
  render(200, 'month');
  assert.deepEqual(calls, [[0, 100, 1200], [60, 120, 1200], [0, 200, 1200]]);
});

test('offline showcase embeds the module verbatim and exposes the required controls', () => {
  const demo = readFileSync(new URL('../docs/stats-ring-final.html', import.meta.url), 'utf8');
  assert.ok(demo.includes(`// copied from public/statsRing.js — keep in sync\n${modelSource}// end copied block`));
  assert.doesNotMatch(demo, /<script[^>]+src=|<link[^>]+href=/);
  for (const preset of ['0', '0.003', '1', '2', '5', '12', '40', 'big']) assert.ok(demo.includes(`data-preset="${preset}"`));
  assert.equal((demo.match(/max="40000"/g) || []).length, 2);
  assert.ok(demo.includes('data-theme="light"'));
});
