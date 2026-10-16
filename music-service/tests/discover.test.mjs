import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { Accounts, mountAccounts, validatePlaylists, wrapPostgres } from '../src/accounts.js';
import { normalizeSongPart, songKey, isTrendingSong, validatePlays } from '../src/lib/discover.js';
import { ChartsCache, parseAppleChart, parseBillboardChart } from '../src/lib/charts.js';

test('normalization and discovery title/artist filters', () => {
  assert.equal(normalizeSongPart('  ＨＥＬＬＯ　 World  '), 'hello world');
  assert.equal(songKey(' HELLO ', 'Ａrtist'), songKey('hello', 'artist'));
  assert.notEqual(songKey('a|b', 'c'), songKey('a', 'b|c'));
  for (const title of ['BV1Ab411c7xy', '【演唱会】晴天', 'P12 合唱', '歌曲合集', '高清修复版', '4K歌曲', '车载音乐', '慢摇', '纯享版', 'live录播', '字'.repeat(31)]) assert.equal(isTrendingSong({ title, artist: '周杰伦' }), false, title);
  for (const artist of ['Singer_official', '某UP主', '录播账号']) assert.equal(isTrendingSong({ title: '晴天', artist }), false);
  for (const title of ['晴天', '光年之外', '再見', '成都']) assert.equal(isTrendingSong({ title, artist: '歌手' }), true, title);
  assert.equal(isTrendingSong({ title: '晴天P12', artist: '周杰伦' }), false);
  assert.throws(() => validatePlays({ deviceId: 'device-id', plays: [{ title: '歌', artist: '人', completed: -1 }] }), { code: 'INPUT' });
  assert.throws(() => validatePlays({ deviceId: 'device-id', plays: Array(501).fill({}) }), { code: 'INPUT' });
});

for (const engine of ['sqlite', 'postgres']) test(`${engine}: one listener immediately populates cached trending with full completed totals`, async t => {
  const pg = engine === 'postgres' ? new PGlite() : null;
  const a = pg ? new Accounts(wrapPostgres(pg, fn => pg.transaction(tx => fn(wrapPostgres(tx))), () => pg.close())) : await Accounts.memory();
  if (pg) await a.migrate();
  t.after(() => a.close());
  const { user } = await a.register('solo-listener', 'correct horse battery staple');
  const now = Date.now();
  assert.deepEqual((await a.trending(now)).tracks, []);
  const upload = (deviceId, plays) => a.recordPlays(user.id, { deviceId, plays: plays.map(([title, completed]) => ({ title, artist: '歌手', completed })) });
  await upload('device-one', [['光年之外', 1], ['再見', 1], ['成都', 2]]);
  let tracks = (await a.trending(now + 1)).tracks;
  assert.equal(tracks[0].title, '成都');
  assert.deepEqual(new Set(tracks.map(track => track.title)), new Set(['光年之外', '再見', '成都']));
  // Cumulative retry/out-of-order uploads cannot inflate or reduce totals.
  await upload('device-one', [['光年之外', 1], ['再見', 1], ['成都', 1]]);
  assert.equal((await a.trending(now + 2)).tracks[0].completed, 2);
  await upload('device-one', [['光年之外', 60]]);
  await upload('device-two', [['光年之外', 3]]);
  tracks = (await a.trending(now + 3)).tracks;
  assert.equal(tracks[0].title, '光年之外');
  assert.equal(tracks[0].completed, 63, 'completed plays are summed without a per-user cap');
  const second = await a.register('second-listener', 'correct horse battery staple');
  await a.recordPlays(second.user.id, { deviceId: 'device-one', plays: [{ title: '光年之外', artist: '歌手', completed: 4 }] });
  assert.equal((await a.trending(now + 4)).tracks[0].completed, 67, 'all accounts contribute, including the first listener');
});

for (const engine of ['sqlite', 'postgres']) test(`${engine}: cumulative plays are idempotent across devices; public playlists require accepted friendship`, async t => {
  const pg = engine === 'postgres' ? new PGlite() : null;
  const a = pg ? new Accounts(wrapPostgres(pg, fn => pg.transaction(tx => fn(wrapPostgres(tx))), () => pg.close())) : await Accounts.memory();
  if (pg) await a.migrate();
  t.after(() => a.close());
  const users = [];
  for (const name of ['alice', 'bob', 'charlie']) {
    const session = await a.register(name, 'correct horse battery staple');
    await a.activate(session.token, await a.invite()); users.push(session.user.id);
  }
  const [alice, bob, charlie] = users;
  const upload = (deviceId, completed) => a.recordPlays(alice, { deviceId, plays: [{ title: ' Song ', artist: ' Artist ', cover: 'https://example.com/c.jpg', completed }] });
  await upload('device-one', 4); await upload('device-one', 4); await upload('device-one', 2); await upload('device-two', 3); await upload('device-one', 5);
  await a.recordPlays(bob, { deviceId: 'device-one', plays: [{ title: 'ＳＯＮＧ', artist: 'ARTIST', completed: 2 }] });
  assert.equal((await a.trending()).tracks[0].completed, 10);
  await a.migrate();
  assert.equal((await a.db.all('SELECT completed FROM play_counts WHERE user_id=$1', [alice]))[0].completed, 8);
  const track = { id: 'local-file', title: 'Song', artist: 'Artist', cover: 'https://example.com/c.jpg', sourceId: 'youtube:abcd', hash: 'private', pageUrl: 'https://example.com/private', duration: 100 };
  await a.saveLibrary(bob, 0, [{ id: 'public', name: '公开', isPublic: true, tracks: [track] }, { id: 'private', name: '私密', tracks: [track] }]);
  assert.equal(validatePlaylists([{ id: 'default', tracks: [] }])[0].isPublic, false);
  await assert.rejects(a.publicPlaylists(alice, bob), { status: 403 });
  await a.requestFriend(alice, bob);
  await assert.rejects(a.publicPlaylists(alice, bob), { status: 403 });
  await a.respondFriend(bob, alice, true);
  const result = await a.publicPlaylists(alice, bob);
  assert.equal(result.playlists.length, 1);
  assert.deepEqual(Object.keys(result.playlists[0].tracks[0]).sort(), ['artist', 'cover', 'duration', 'sourceId', 'title']);
  assert.equal(result.playlists[0].tracks[0].cover, track.cover);
  await assert.rejects(a.publicPlaylists(charlie, bob), { status: 403 });
  await a.removeFriend(alice, bob);
  await assert.rejects(a.publicPlaylists(alice, bob), { status: 403 });
});

test('account discovery routes require authentication and activation', async t => {
  const a = await Accounts.memory(); t.after(() => a.close());
  const app = express(); app.use(express.json()); mountAccounts(app, a, (_req, _res, next) => next());
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await a.register('alice', 'correct horse battery staple');
  for (const endpoint of ['/discover/trending', '/account/friends/missing/playlists']) {
    assert.equal((await fetch(base + endpoint)).status, 401);
    assert.equal((await fetch(base + endpoint, { headers: { Authorization: `Bearer ${session.token}` } })).status, 403);
  }
  const response = await fetch(base + '/account/plays', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ deviceId: 'device-one', plays: [] }) });
  assert.equal(response.status, 403);
});

test('chart parsers use offline fixtures and reject malformed feeds', async () => {
  const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}-chart.json`, import.meta.url), 'utf8'));
  assert.equal(parseAppleChart(await fixture('apple')).length, 2);
  assert.equal(parseAppleChart(await fixture('apple'))[0].cover, 'https://example.com/cover.jpg');
  assert.equal(parseBillboardChart(await fixture('billboard'))[0].title, 'Morning Light');
  assert.throws(() => parseAppleChart({})); assert.throws(() => parseBillboardChart({}));
});

test('chart fallback, daily refresh, persistence and stale cache work without network', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hh-charts-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0, time = 100000000;
  const apple = JSON.parse(await readFile(new URL('./fixtures/apple-chart.json', import.meta.url), 'utf8'));
  const billboard = JSON.parse(await readFile(new URL('./fixtures/billboard-chart.json', import.meta.url), 'utf8'));
  const cache = new ChartsCache({ dataDir: dir, now: () => time, fetcher: async url => { calls++; return { ok: true, json: async () => url.includes('billboard') ? billboard : apple }; } });
  assert.equal(cache.chart('apple-gb').stale, true);
  assert.equal(cache.chart('apple-gb').title, '英国流行榜');
  assert.equal(cache.chart('missing'), null);
  await cache.refresh(); assert.equal(calls, 3); assert.equal(cache.chart('apple-us').stale, false);
  await cache.refresh(); assert.equal(calls, 3);
  const restored = new ChartsCache({ dataDir: dir, now: () => time, fetcher: async () => { throw Error('offline'); } });
  await restored.init(); t.after(() => restored.stop());
  assert.equal(restored.chart('apple-us').tracks[0].title, 'Morning Light');
  time += 86400000; assert.equal(restored.chart('apple-us').stale, true);
  await restored.refresh(); assert.equal(restored.chart('apple-us').tracks[0].title, 'Morning Light');
});
