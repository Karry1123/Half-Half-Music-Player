import test from 'node:test';
import assert from 'node:assert/strict';
import { artistKey, artistSplitStore, hasSeparator, resolveArtists } from '../public/artistSplit.js';
import { ListeningStats } from '../public/listeningStats.js';

const names = (field, context) => resolveArtists(field, context).artists;
const asks = (field, context) => resolveArtists(field, context).questions.map(q => q.label);

test('glued and punctuated featuring markers are certain separators', () => {
  for (const field of ['A+Featuring：B', 'A & feat. B', 'A featuring: B', 'A&ft:B', 'A + featuring B', 'A ft：B']) {
    assert.deepEqual(names(field), ['A', 'B'], field);
    assert.deepEqual(asks(field), []);
  }
  assert.deepEqual(names('張震嶽+Featuring：蔡健雅'), ['張震嶽', '蔡健雅']);
  for (const field of ['Featuring Nobody', 'Max', 'Alexandra']) assert.deepEqual(names(field), [field]);
});

test('custom names override pieces and round trip through the store with strictly newer merges', () => {
  const storage = new Map([['hh.artistSplit', JSON.stringify({ legacy: 'split' })]]);
  globalThis.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  try {
    const field = '張震嶽+Featuring：蔡健雅', key = artistKey(field);
    artistSplitStore.decide(key, 'split', 100, [' 张震岳 ', '蔡健雅']);
    const result = resolveArtists(field, { decisions: artistSplitStore.all() });
    assert.deepEqual(result.artists, ['张震岳', '蔡健雅']);
    assert.deepEqual(result.decided[0].pieces, result.artists);
    assert.deepEqual(result.decided[0].defaultPieces, ['張震嶽', '蔡健雅']);
    assert.deepEqual(artistSplitStore.entries(), [{ key: 'legacy', answer: 'split', at: 0 }, { key, answer: 'split', at: 100, names: result.artists }]);
    assert.equal(artistSplitStore.merge([{ key, answer: 'keep', at: 100 }]), false);
    assert.equal(artistSplitStore.merge([{ key, answer: 'split', at: 100, names: ['X', 'Y'] }]), false);
    assert.equal(artistSplitStore.merge([{ key, answer: 'split', at: 99, names: ['X', 'Y'] }]), false);
    assert.equal(artistSplitStore.merge([{ key, answer: 'split', at: 101, names: ['X', 'Y'] }]), true);
    assert.deepEqual(names(field, { decisions: artistSplitStore.all() }), ['X', 'Y']);
    artistSplitStore.merge([{ key, answer: 'split', at: 102 }]);
    assert.deepEqual(names(field, { decisions: artistSplitStore.all() }), ['張震嶽', '蔡健雅']);
    artistSplitStore.decide(key, 'keep', 103);
    assert.equal(artistSplitStore.entries().find(row => row.key === key).names, undefined);
    for (const invalid of [[], ['A'], ['A', 'a'], ['張震嶽', '张震岳'], ['', 'B'], ['A'.repeat(101), 'B']]) {
      artistSplitStore.decide(key, 'split', 104, invalid);
      assert.equal(artistSplitStore.all()[key], 'keep');
    }
    const ambiguous = resolveArtists('A & B', { decisions: { 'a & b': { answer: 'split', names: ['C', 'D'] } } });
    assert.deepEqual(ambiguous.artists, ['C', 'D']);
    assert.deepEqual(ambiguous.decided[0].defaultPieces, ['A', 'B']);
  } finally { delete globalThis.localStorage; }
});

test('unambiguous markers always split, in every spelling', () => {
  for (const field of ['张震岳 featuring 蔡健雅', '张震岳 feat. 蔡健雅', '张震岳 ft 蔡健雅', '张震岳 (feat. 蔡健雅)', '张震岳（Feat 蔡健雅）', '张震岳、蔡健雅', '张震岳；蔡健雅', '张震岳，蔡健雅'])
    assert.deepEqual(names(field), ['张震岳', '蔡健雅'], field);
  assert.deepEqual(names('A feat. B、C'), ['A', 'B', 'C']);
  assert.deepEqual(names('A feat. A'), ['A'], 'the same performer is credited once');
  assert.deepEqual(names('  周杰伦  '), ['周杰伦']);
  assert.deepEqual(names(''), []);
  assert.equal(hasSeparator('Featuring Nobody'), false, 'a leading word is not a marker');
});

test('ambiguous markers keep the field whole and ask, unless every part is a known artist', () => {
  assert.deepEqual(names('Calvin Harris & Dua Lipa'), ['Calvin Harris & Dua Lipa']);
  assert.deepEqual(asks('Calvin Harris & Dua Lipa'), ['Calvin Harris & Dua Lipa']);
  assert.deepEqual(resolveArtists('Calvin Harris & Dua Lipa').questions[0].pieces, ['Calvin Harris', 'Dua Lipa']);
  const known = new Set(['calvin harris', 'dua lipa'].map(artistKey));
  assert.deepEqual(names('Calvin Harris & Dua Lipa', { known }), ['Calvin Harris', 'Dua Lipa']);
  assert.deepEqual(asks('Calvin Harris & Dua Lipa', { known }), []);
  assert.deepEqual(asks('Calvin Harris & Someone New', { known }), ['Calvin Harris & Someone New'], 'one unknown part is not enough');
  for (const field of ['A / B', 'A, B', 'A x B', 'A × B', 'A and B', 'A with B', 'A vs. B', 'A + B', 'A＆B'])
    assert.deepEqual(asks(field), [field], field);
  assert.deepEqual(names('Max'), ['Max'], 'a bare x inside a word is not a marker');
  assert.deepEqual(names('Alexandra'), ['Alexandra']);
});

test('acts whose own name contains a marker are one act and are never asked about', () => {
  for (const field of ['AC/DC', 'Simon & Garfunkel', 'Earth, Wind & Fire', 'Tyler, The Creator', 'Bob Marley & The Wailers',
    'Florence + The Machine', 'Tom Petty and the Heartbreakers', 'Chloe x Halle']) {
    assert.deepEqual(names(field), [field], field);
    assert.deepEqual(asks(field), [], field);
  }
  assert.deepEqual(names('AC/DC feat. Someone'), ['AC/DC', 'Someone']);
});

test('the user\'s answer is remembered per field, including traditional and case variants', () => {
  const key = artistKey('張震嶽 & 蔡健雅');
  assert.equal(key, artistKey('张震岳 & 蔡健雅'));
  assert.deepEqual(names('张震岳 & 蔡健雅', { decisions: { [key]: 'split' } }), ['张震岳', '蔡健雅']);
  assert.deepEqual(asks('张震岳 & 蔡健雅', { decisions: { [key]: 'split' } }), []);
  assert.deepEqual(names('张震岳 & 蔡健雅', { decisions: { [key]: 'keep' } }), ['张震岳 & 蔡健雅']);
  assert.deepEqual(asks('张震岳 & 蔡健雅', { decisions: { [key]: 'keep' } }), []);
  let notified = 0;
  const stop = artistSplitStore.subscribe(() => notified++);
  artistSplitStore.decide('x & y', 'split');
  artistSplitStore.decide('x & y', 'maybe');
  stop();
  assert.equal(notified, 1);
  assert.equal(artistSplitStore.all()['x & y'], 'split');
});

test('a collaboration credits its full time to each performer and merges with their solo plays', async () => {
  const stats = new ListeningStats({ userId: 'u', indexedDB: null });
  await stats.ready();
  const now = +new Date(2026, 10, 10, 12), at = +new Date(2026, 10, 9, 10);
  const meta = (title, artist) => ({ title, artist, cover: '' });
  stats.stats.trackMetadata = {
    solo: meta('思念是一种病(独唱)', '张震岳'), duet: meta('思念是一种病', '張震嶽 featuring 蔡健雅'),
    amp: meta('One Kiss', 'Calvin Harris & Dua Lipa'), band: meta('Thunderstruck', 'AC/DC'), none: meta('Untitled', ''),
  };
  const record = (id, trackId, seconds) => ({ id, userId: 'u', trackId, durationPlayed: seconds, timestamp: at, localDay: '2026-11-09' });
  stats.records = [record('1', 'solo', 100), record('2', 'duet', 240), record('3', 'amp', 200), record('4', 'band', 50), record('5', 'none', 10)];
  const first = stats.artistBreakdown('week', now, {});
  assert.deepEqual(first.artists, [
    // Simplified and traditional spellings merge; the spelling with more listening time is shown.
    { artist: '張震嶽', seconds: 340 }, { artist: '蔡健雅', seconds: 240 }, { artist: 'Calvin Harris & Dua Lipa', seconds: 200 },
    { artist: 'AC/DC', seconds: 50 }, { artist: '未知歌手', seconds: 10 },
  ]);
  assert.deepEqual(first.questions.map(q => [q.label, q.pieces, q.seconds]), [['Calvin Harris & Dua Lipa', ['Calvin Harris', 'Dua Lipa'], 200]]);
  const key = first.questions[0].key;
  const split = stats.artistBreakdown('week', now, { [key]: 'split' });
  assert.deepEqual(split.artists.slice(2, 4), [{ artist: 'Calvin Harris', seconds: 200 }, { artist: 'Dua Lipa', seconds: 200 }]);
  const custom = stats.artistBreakdown('week', now, { [key]: { answer: 'split', names: ['Calvin', 'Dua'] } });
  assert.deepEqual(custom.artists.slice(2, 4), [{ artist: 'Calvin', seconds: 200 }, { artist: 'Dua', seconds: 200 }]);
  assert.deepEqual(split.questions, []);
  assert.deepEqual(stats.artistBreakdown('week', now, { [key]: 'keep' }).questions, []);
  // A solo track by each performer anywhere in the library settles it without asking.
  stats.stats.trackMetadata.c = meta('Slide', 'Calvin Harris');
  stats.stats.trackMetadata.d = meta('Levitating', 'Dua Lipa');
  assert.deepEqual(stats.artistBreakdown('week', now, {}).questions, []);
  assert.deepEqual(stats.artistTotals('week', now, {}).slice(2, 4), [{ artist: 'Calvin Harris', seconds: 200 }, { artist: 'Dua Lipa', seconds: 200 }]);
});

test('answers carry their time, merge newest-first and read values saved before syncing existed', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  try {
    store.set('hh.artistSplit', JSON.stringify({ 'old & plain': 'split', broken: { answer: 'maybe', at: 1 } }));
    assert.deepEqual(artistSplitStore.all(), { 'old & plain': 'split' });
    assert.deepEqual(artistSplitStore.entries(), [{ key: 'old & plain', answer: 'split', at: 0 }]);
    artistSplitStore.decide('a & b', 'keep', 100);
    const events = [];
    const stop = artistSplitStore.subscribe((key, origin) => events.push([key, origin]));
    assert.equal(artistSplitStore.merge([
      { key: 'a & b', answer: 'split', at: 50 },          // older than the local answer: ignored
      { key: 'old & plain', answer: 'keep', at: 10 },     // newer than an untimed legacy answer: applied
      { key: 'c & d', answer: 'split', at: 70 },          // new
      { key: 'bad', answer: 'maybe', at: 1 }, { key: '', answer: 'keep', at: 1 }, { key: 'x', answer: 'keep', at: 1.5 },
    ]), true);
    assert.deepEqual(artistSplitStore.all(), { 'old & plain': 'keep', 'a & b': 'keep', 'c & d': 'split' });
    assert.equal(artistSplitStore.merge([{ key: 'c & d', answer: 'split', at: 70 }]), false, 'nothing new: no notification');
    assert.equal(artistSplitStore.merge(undefined), false);
    artistSplitStore.decide('a & b', 'split', 200);
    stop();
    assert.deepEqual(events, [[null, 'remote'], ['a & b', 'local']]);
    assert.deepEqual(JSON.parse(store.get('hh.artistSplit'))['a & b'], { answer: 'split', at: 200 });
  } finally { delete globalThis.localStorage; }
});

test('answered fields are listed with their current answer so they can be changed', async () => {
  const stats = new ListeningStats({ userId: 'u', indexedDB: null });
  await stats.ready();
  const meta = artist => ({ title: 'T', artist, cover: '' });
  stats.stats.trackMetadata = {
    a: meta('Calvin Harris & Dua Lipa'), b: meta('CALVIN HARRIS & DUA LIPA'), c: meta('张震岳 feat. 蔡健雅'),
    d: meta('X / Y feat. Z'), e: meta('Unanswered & Pair'), f: meta('AC/DC'),
  };
  const decisions = { [artistKey('Calvin Harris & Dua Lipa')]: 'split', [artistKey('X / Y')]: 'keep', 'gone & away': 'split' };
  assert.deepEqual(stats.artistDecisionList(decisions), [
    { key: 'calvin harris & dua lipa', label: 'Calvin Harris & Dua Lipa', pieces: ['Calvin Harris', 'Dua Lipa'], defaultPieces: ['Calvin Harris', 'Dua Lipa'], answer: 'split' },
    { key: 'x / y', label: 'X / Y', pieces: ['X', 'Y'], defaultPieces: ['X', 'Y'], answer: 'keep' },
  ], 'one row per field; unanswered, unambiguous and no-longer-present fields are not listed');
  assert.deepEqual(stats.artistDecisionList({}), []);
  assert.deepEqual(resolveArtists('X / Y feat. Z', { decisions }).artists, ['X / Y', 'Z']);
  // Flipping the answer changes both the list and the totals.
  const flipped = { ...decisions, [artistKey('X / Y')]: 'split' };
  assert.equal(stats.artistDecisionList(flipped)[1].answer, 'split');
  assert.deepEqual(resolveArtists('X / Y feat. Z', { decisions: flipped }).artists, ['X', 'Y', 'Z']);
});
