import test from 'node:test';
import assert from 'node:assert/strict';
import { upNextTracks, songResults } from '../public/playerPresentation.js';

test('Up Next projects the shared list after current, without mutation or a second queue', () => {
  const tracks = Object.freeze([Object.freeze({ id: 'a' }), Object.freeze({ id: 'b' }), Object.freeze({ id: 'c' })]);
  assert.deepEqual(upNextTracks(tracks, 'b'), [tracks[2]]);
  assert.deepEqual(upNextTracks(tracks, 'c'), []);
  assert.deepEqual(upNextTracks(tracks, null), tracks);
  assert.deepEqual(upNextTracks([], 'a'), []);
});
test('best match ranks real songs and provider groups retain every remaining result exactly once', () => {
  const tracks = [{ id: '1', title: 'Another Song', artist: 'Artist', source: 'youtube' },
    { id: '2', title: 'Evening Air', artist: 'Artist', source: 'bilibili', version: 'Live', quality: '192k' },
    { id: '3', title: 'Evening Air Acoustic', source: 'youtube' }];
  const before = structuredClone(tracks);
  const { best, groups } = songResults(tracks, 'evening air');
  assert.equal(best, tracks[1]);
  assert.equal(best.version, 'Live'); assert.equal(best.quality, '192k');
  assert.deepEqual(groups.flatMap(g => g.tracks).map(t => t.id), ['3', '1']);
  assert.deepEqual(tracks, before);
  assert.deepEqual(songResults([], 'missing'), { best: null, groups: [] });
});

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const musicSource = readFileSync(new URL('../src/store/useMusic.js', import.meta.url), 'utf8');
function searchHarness(state, request) {
  const source = musicSource.slice(musicSource.indexOf('  async search()'), musicSource.indexOf('  async download('));
  return vm.runInNewContext(`let searchEpoch = 0; ({${source}})`, {
    get: () => state, set: patch => Object.assign(state, patch), musicApi: { search: request },
  });
}
test('same-query refresh retains results; changed query discards them and ignores late responses', async () => {
  const old = { results: [{ id: 'old' }] }, state = { query: 'first', sources: [], versions: 'original', result: old, resultKey: JSON.stringify(['first', [], 'original']) };
  const requests = [];
  const search = searchHarness(state, () => new Promise(resolve => requests.push(resolve)));
  const first = search.search();
  assert.equal(state.result, old);
  state.query = 'second';
  const second = search.search();
  assert.equal(state.result, null);
  const fresh = { results: [{ id: 'new' }] };
  requests[1](fresh); await second;
  requests[0](old); await first;
  assert.equal(state.result, fresh); assert.equal(state.searching, false);
});
test('changing provider invalidates results and failed refresh retains same-key content', async () => {
  const old = { results: [{ id: 'old' }] }, state = { query: 'song', sources: ['bilibili'], versions: 'original', result: old, resultKey: JSON.stringify(['song', [], 'original']) };
  const search = searchHarness(state, async () => { throw new Error('source unavailable'); });
  await search.search(); assert.equal(state.result, null); assert.equal(state.error, 'source unavailable');
  state.result = old; state.resultKey = JSON.stringify(['song', ['bilibili'], 'original']);
  await search.search(); assert.equal(state.result, old); assert.equal(state.searching, false);
});
test('React downloads stay in library until explicitly appended without disturbing current selection', () => {
  const source = readFileSync(new URL('../src/engine/session.js', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('  syncLibrary('), source.indexOf('  /** 拖入 / 选择的本地音频文件 */'));
  const state = { playlist: [], currentId: 'keep' };
  const engine = vm.runInNewContext(`({${method}})`, { get: () => state, set: patch => Object.assign(state, patch) });
  engine.sendPlaylist = () => {};
  engine.syncLibrary([]);
  const library = [{ file: 'download.mp3', title: 'Song' }];
  engine.syncLibrary(library); assert.equal(state.playlist.length, 0);
  engine.syncLibrary(library, ['download.mp3']); assert.equal(state.playlist.length, 1); assert.equal(state.currentId, 'keep');
  engine.syncLibrary(library, ['download.mp3']); assert.equal(state.playlist.length, 1);
});


test('Up Next respects sequential, list repeat and manual next in single repeat', () => {
  const tracks = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  const ids = (current, mode) => upNextTracks(tracks, current, { mode }).map(t => t.id);
  assert.deepEqual(ids('c', 'order'), ['d']);
  assert.deepEqual(ids('d', 'order'), []);
  assert.deepEqual(ids('c', 'loopAll'), ['d', 'a', 'b']);
  assert.deepEqual(ids('c', 'loopOne'), ['d', 'a', 'b']);
  assert.deepEqual(upNextTracks([{ id: 'a' }], 'a', { mode: 'loopOne' }), []);
});

test('Up Next uses the existing shuffled bag and forward stack without mutation or rerolling', () => {
  const tracks = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  const queue = { mode: 'shuffle', forward: ['b', 'c'], bag: ['d', 'b'] };
  const before = structuredClone(queue);
  assert.deepEqual(upNextTracks(tracks, 'a', queue).map(t => t.id), ['c', 'b', 'd']);
  assert.deepEqual(queue, before);
  assert.deepEqual(upNextTracks(tracks, 'a', { mode: 'shuffle', bag: [] }), []);
  assert.deepEqual(upNextTracks(tracks, 'c', { mode: 'shuffle', bag: ['b', 'a', 'd'] }).map(t => t.id), ['b', 'a', 'd']);
});
