import test from 'node:test';
import assert from 'node:assert/strict';
import { sortPlaylistTracks, trendingBadge } from '../public/discoveryUI.js';
import { ListeningStats } from '../public/listeningStats.js';

test('trending badges distinguish actual completed counts from recommendations', () => {
  assert.equal(trendingBadge({ completed: 1420 }, 0), '最热');
  assert.equal(trendingBadge({ completed: 3 }, 2), '热门');
  assert.equal(trendingBadge({ completed: 3 }, 7), '热听');
  assert.doesNotMatch(trendingBadge({ completed: 1420 }, 0), /\d/);
  for (const completed of [undefined, 0, -1, NaN]) assert.equal(trendingBadge({ completed }), '推荐');
});
test('playlist sorting leaves original order and uses requested count, name and duration', () => {
  const a = { id: 'a', title: 'B', duration: 20 }, b = { id: 'b', title: 'A', duration: 10 };
  const original = [a, b];
  for (const mode of ['count', 'name', 'duration']) assert.deepEqual(sortPlaylistTracks(original, mode, t => t.id === 'b' ? 2 : 1), [b, a]);
  assert.deepEqual(sortPlaylistTracks(original), original);
  assert.deepEqual(original, [a, b]);
});
test('completed uploads aggregate normalized title and artist and preserve cumulative totals', async () => {
  const stats = new ListeningStats({ userId: 'u', persistence: { load: async () => ({ stats: { completedPlayCount: { a: 2, b: 3, c: 1 }, trackMetadata: { a: {title: ' Ａ ', artist: 'B' }, b: {title: 'a', artist: ' b ' } } } }) } });
  await stats.ready();
  assert.equal(stats.completedUploads().length, 1);
  assert.equal(stats.completedUploads()[0].completed, 5);
  assert.ok(stats.stats.deviceId);
});
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PlayQueue } from '../public/playQueue.js';
test('sorted playback keeps its queue order through queue synchronization', async () => {
  const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  const slice = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
  const state = { activePlaylistId: 'p', library: [{id:'a'}, {id:'b'}, {id:'c'}], playMode: 'order' };
  const playlist = {id: 'p', name: '歌单', trackIds:['a','b','c']};
  const context = {get: () => state, set: patch => Object.assign(state, patch), ALL_ID:'all', playlistStore:{get: () => playlist}, resolveScope: () => ['a','b','c'], missingFromLibrary: () => [], ensureInLibrary: async () => {}, PlayQueue};
  const scope = vm.runInNewContext(`({${slice('  scopeIds() {', '  /** 当前曲目 + 播放范围')}})`, context);
  const play = vm.runInNewContext(`({${slice('  async playPlaylist(', '  /** 房主：告诉 Guest')}})`, context);
  let current;
  const session = {...scope,...play, announcePlaylist(){}, notifySynced(){}, loadTrack: async id => {current=id;}};
  await session.playPlaylist('p', {orderedIds:['c','b','a']});
  assert.equal(current, 'c');
  assert.deepEqual([...session.scopeIds()], ['c','b','a']);
  // Changing a view alone never calls the playback method or alters the current queue.
  sortPlaylistTracks(state.library, 'name');
  assert.equal(current, 'c');
  assert.deepEqual([...session.scopeIds()], ['c','b','a']);
});
import { discoverySnapshot, loadDiscovery, DiscoverSections } from '../public/discoveryUI.js';
import React from 'react';
import htm from 'htm';
import { renderToStaticMarkup } from 'react-dom/server';

test('discovery first mount has only skeletons; remount reuses real songs without demo fallback', async () => {
  const client = { required: true, request: async () => ({ tracks: [{ title: 'Real song', artist: 'Artist' }] }) };
  const render = () => renderToStaticMarkup(React.createElement(DiscoverSections, {
    client, fallback: [{ title: 'Demo song' }], onPick() {},
  }));
  const first = render();
  assert.match(first, /aria-busy="true"/);
  assert.doesNotMatch(first, /Demo song|Real song/);
  await loadDiscovery(client);
  const next = render();
  assert.match(next, /Real song/);
  assert.doesNotMatch(next, /Demo song|animate-pulse/);
});

test('discovery deduplicates requests, skips fresh fetches and preserves identity for unchanged or failed refreshes', async () => {
  let resolve, calls = 0;
  const client = { required: true, request: () => { calls++; return new Promise(r => { resolve = r; }); } };
  const pending = loadDiscovery(client);
  assert.equal(loadDiscovery(client), pending);
  resolve({ tracks: [{ title: 'Song', completed: 1 }] });
  const initial = await pending;
  assert.equal(await loadDiscovery(client), initial);
  assert.equal(calls, 1);
  const refresh = loadDiscovery(client, { force: true });
  assert.equal(discoverySnapshot(client), initial, 'cached songs remain during refresh');
  resolve({ tracks: [{ title: 'Song', completed: 1 }] });
  assert.equal(await refresh, initial, 'unchanged data must not trigger React updates');
  client.request = async () => { throw new Error('Offline'); };
  assert.equal(await loadDiscovery(client, { force: true }), initial);
  client.request = async () => ({ tracks: [] });
  assert.deepEqual((await loadDiscovery(client, { force: true })).tracks, [], 'authoritative empty results clear stale songs');
});

test('legacy discovery never displays the demo catalog', () => {
  const markup = renderToStaticMarkup(React.createElement(DiscoverSections, {
    client: { required: false }, fallback: [{ title: 'Demo song' }], onPick() {},
  }));
  assert.doesNotMatch(markup, /Demo song|animate-pulse/);
});

test('discovery memo receives a stable pick callback that forwards to the latest parent handler', () => {
  const source = readFileSync(new URL('../public/discoveryUI.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  let pickReference, callback;
  const Discover = vm.runInNewContext(`${source}; DiscoverSections`, {
    React, htm, Music2: () => null, Flame: () => null, X: () => null,
    useRef: initial => pickReference ||= { current: initial },
    useCallback: fn => callback ||= fn,
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect() {},
  });
  const client = { required: false }, calls = [];
  const first = Discover({ client, onPick: query => calls.push(`old:${query}`) });
  const second = Discover({ client, onPick: query => calls.push(`new:${query}`) });
  const firstCards = React.Children.toArray(first.props.children).find(child => child.props?.tracks);
  const secondCards = React.Children.toArray(second.props.children).find(child => child.props?.tracks);
  assert.equal(firstCards.props.onPick, secondCards.props.onPick);
  assert.equal(firstCards.props.tracks, secondCards.props.tracks);
  firstCards.props.onPick('song');
  assert.deepEqual(calls, ['new:song']);
});
