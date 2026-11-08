import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import htm from 'htm';
import { gainFor } from '../public/audioAnalysis.js';

const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('../public/trackVolume.js', import.meta.url), 'utf8');
function storeHarness(raw = null) {
  const data = new Map(raw === null ? [] : [['hh.trackVolume', raw]]);
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const create = () => vm.runInNewContext(`${storeSource.replace('export const', 'const')}; trackVolumeStore`, { localStorage: storage });
  return { store: create(), data, create };
}
const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : [];

test('track trims persist independently, round to 1 dB, clamp, reset and unsubscribe', () => {
  const { store, create, data } = storeHarness();
  const changes = [], unsubscribe = store.subscribe(id => changes.push(id));
  assert.equal(store.getTrim('a'), 0);
  assert.equal(store.setTrim('a', 3.2), 3);
  assert.equal(store.setTrim('b', -99), -12);
  assert.equal(create().getTrim('a'), 3);
  assert.deepEqual(JSON.parse(data.get('hh.trackVolume')), [{ id: 'a', db: 3 }, { id: 'b', db: -12 }]);
  assert.equal(store.setTrim('a', 99), 12);
  assert.equal(store.setTrim('a', Infinity), 0);
  store.setTrim('a', 0); unsubscribe(); store.setTrim('a', 1);
  assert.equal(changes.length, 5);
  assert.equal(store.getTrim('b'), -12);
  assert.equal(store.getTrim(null), 0);
  assert.equal(storeHarness('{broken').store.getTrim('a'), 0);
  assert.equal(storeHarness('[{"id":"a","db":90}]').store.getTrim('a'), 12);
});

test('trim multiplies normalization and immediately updates only the current output track', () => {
  const { store } = storeHarness();
  let normalize = true, renderedGain;
  const code = source.slice(source.indexOf('class AudioOut {'), source.indexOf('class Session {'));
  const Out = vm.runInNewContext(`${code}; AudioOut`, {
    Audio: class { addEventListener() {} }, trackVolumeStore: store, gainFor,
    get: () => ({ volume: 0.8 }), audioDuck: 0.5, stored: () => String(normalize),
  });
  const out = new Out();
  out.ctx = { currentTime: 0 }; out.gain = { gain: { setTargetAtTime: value => { renderedGain = value; } } };
  out.applyTrackAnalysis({ version: 1, loudness: -10 }, 'local');
  store.setTrim('local', 3);
  assert.ok(Math.abs(renderedGain - 0.4 * gainFor(-10, { maxBoost: 6 }) * 10 ** (3 / 20)) < 1e-10);
  const previous = renderedGain; store.setTrim('other', 12); assert.equal(renderedGain, previous);
  normalize = false; out.refreshTrackGain();
  assert.ok(Math.abs(renderedGain - 0.4 * 10 ** (3 / 20)) < 1e-10);
  out.applyTrackAnalysis(null, 'other'); assert.ok(Math.abs(renderedGain - 0.4 * 10 ** (12 / 20)) < 1e-10);
  out.gain = null; out.refreshTrackGain(); assert.equal(out.audio.volume, 0.4);
  store.setTrim('other', -6); assert.ok(Math.abs(out.audio.volume - 0.4 * 10 ** (-6 / 20)) < 1e-10);
  assert.match(source, /trackVolumeId: item\.localId \|\| item\.id/);
  assert.match(source, /trackVolumeId: item\?\.localId \|\| id/);
});

test('full-screen trim row has local +/- buttons, live label, limits and tap/long-press reset', () => {
  const { store } = storeHarness();
  const effects = [], revisions = [];
  const start = source.indexOf('function TrackVolumeTrim(');
  const Component = vm.runInNewContext(`${source.slice(start, source.indexOf('function App()', start))}; TrackVolumeTrim`, {
    trackVolumeStore: store, useState: () => [0, fn => revisions.push(fn)], useEffect: fn => effects.push(fn),
    html: htm.bind(React.createElement), Volume1: () => null, Plus: () => null, cx: (...args) => args.filter(Boolean).join(' '),
  });
  const render = (item = { id: 'remote', localId: 'local' }, loaded = true) => flatten(Component({ item, loaded }));
  let nodes = render();
  assert.equal(nodes[0].props.class, 'fsp-trim');
  const label = nodes.find(n => n.props?.['aria-label'] === '重置音量');
  assert.equal(label.props['aria-live'], 'polite'); assert.match(label.props.class, /fsp-muted/);
  assert.equal(nodes.filter(n => n.type === 'button').length, 3);
  const cleanup = effects[0]();
  nodes.find(n => n.props?.['aria-label'] === '提高音量 1 dB').props.onClick();
  assert.equal(store.getTrim('local'), 1); assert.equal(store.getTrim('remote'), 0); assert.equal(revisions.length, 1);
  for (const db of [-12, 12]) {
    store.setTrim('local', db); nodes = render();
    assert.equal(nodes.find(n => n.props?.['aria-label'] === (db < 0 ? '降低音量 1 dB' : '提高音量 1 dB')).props.disabled, true);
    assert.match(nodes.find(n => n.props?.['aria-label'] === '重置音量').props.children.join(''), new RegExp(`音量 ${db > 0 ? '\\+' : ''}${db} dB`));
  }
  label.props.onClick(); assert.equal(store.getTrim('local'), 0);
  store.setTrim('local', -4); label.props.onContextMenu({ preventDefault() {} }); assert.equal(store.getTrim('local'), 0);
  for (const nodes of [render(null), render(undefined, false)]) assert.ok(nodes.filter(n => n.type === 'button').every(n => n.props.disabled));
  cleanup();
  assert.match(source, /fsp-metadata[\s\S]*?<\$\{TrackVolumeTrim\} item=\$\{item\} loaded=\$\{s.loaded\} \/>\s*<\$\{SeekBar\} stacked=/);
});
