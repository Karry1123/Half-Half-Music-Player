// 账号云端音频：分块上传 / 下载 / 配额 / 账号隔离 / 歌单保存后的清理，在 SQLite 和 PGlite（真 PostgreSQL SQL）上各跑一遍
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { Accounts, mountAccounts, wrapPostgres } from '../src/accounts.js';
import { TrackFiles, mountTrackFiles, CHUNK_SIZE } from '../src/trackFiles.js';

const engines = {
  sqlite: () => Accounts.memory(),
  pglite: async () => {
    const pg = new PGlite();
    const accounts = new Accounts(wrapPostgres(pg, (fn) => pg.transaction((tx) => fn(wrapPostgres(tx))), () => pg.close()));
    await accounts.migrate();
    return accounts;
  },
};

async function boot(engine, options) {
  const accounts = await engines[engine](), app = express();
  app.use(express.json());
  const guard = mountAccounts(app, accounts, (_req, _res, next) => next());
  const files = new TrackFiles(accounts.db, options);
  mountTrackFiles(app, guard, files, { express });
  accounts.onLibrarySaved = (userId, playlists) => files.prune(userId, playlists, { graceMs: 0 });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (url, token, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const user = async (name) => {
    const u = (await json('/auth/register', null, { username: name, password: `local-test-password-${name}` })).body;
    await json('/auth/activate', u.token, { code: await accounts.invite() });
    return u.token;
  };
  const upload = async (token, hash, bytes, meta = {}) => {
    const begin = await json(`/account/files/${hash}`, token, { size: bytes.length, mime: 'audio/mp4', fileName: 'song.m4a', ...meta });
    if (begin.status !== 200) return begin;
    if (begin.body.complete) return begin;
    for (let seq = 0; seq * CHUNK_SIZE < bytes.length; seq++) {
      const r = await fetch(`${base}/account/files/${hash}/${seq}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: bytes.subarray(seq * CHUNK_SIZE, (seq + 1) * CHUNK_SIZE) });
      assert.equal(r.status, 200, await r.text());
    }
    return json(`/account/files/${hash}/complete`, token, {});
  };
  const download = async (token, hash) => {
    const r = await fetch(`${base}/account/files/${hash}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, type: r.headers.get('content-type'), length: Number(r.headers.get('content-length')), bytes: new Uint8Array(await r.arrayBuffer()) };
  };
  const close = async () => { await new Promise(r => server.close(r)); await accounts.close(); };
  return { json, user, upload, download, close, files, base };
}

const bytesOf = (n, seed = 1) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; };
const HASH_A = `${(CHUNK_SIZE * 2 + 123).toString(36)}-0123456789abcdef`;
const HASH_B = '1a2b-fedcba9876543210';

for (const engine of Object.keys(engines)) {
  test(`${engine}: chunked upload round-trips byte for byte and is private to the account`, async () => {
    const t = await boot(engine);
    try {
      const a = await t.user('files-a'), b = await t.user('files-b');
      assert.deepEqual((await t.json('/account/files/check', a, { hashes: [HASH_A] })).body.present, []);
      const audio = bytesOf(CHUNK_SIZE * 2 + 123);
      const done = await t.upload(a, HASH_A, audio);
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(done.body.size, audio.length);
      const check = (await t.json('/account/files/check', a, { hashes: [HASH_A, HASH_B, 'bogus'] })).body;
      assert.deepEqual(check.present, [HASH_A]);
      assert.equal(check.used, audio.length);
      const got = await t.download(a, HASH_A);
      assert.equal(got.status, 200);
      assert.equal(got.type, 'audio/mp4');
      assert.equal(got.length, audio.length);
      assert.deepEqual(got.bytes, audio);
      // 同一指纹再传一次：直接告知已完成，不重复占空间
      assert.equal((await t.upload(a, HASH_A, audio)).body.complete, true);
      assert.equal((await t.json('/account/files/check', a, { hashes: [HASH_A] })).body.used, audio.length);
      // 别的账号看不到、下不到
      assert.equal((await t.download(b, HASH_A)).status, 404);
      assert.deepEqual((await t.json('/account/files/check', b, { hashes: [HASH_A] })).body.present, []);
      // 未登录
      assert.equal((await t.download('', HASH_A)).status, 401);
      // 删除
      assert.equal((await t.json(`/account/files/${HASH_A}`, a, undefined, 'DELETE')).status, 200);
      assert.equal((await t.download(a, HASH_A)).status, 404);
    } finally { await t.close(); }
  });

  test(`${engine}: incomplete uploads are not served; wrong chunk sizes, oversize files and quota are rejected`, async () => {
    const t = await boot(engine, { quotaBytes: 3000, maxFileBytes: 2500 });
    try {
      const a = await t.user('files-c');
      const begin = await t.json(`/account/files/${HASH_B}`, a, { size: 1000, mime: 'audio/flac', fileName: 'x.flac' });
      assert.equal(begin.status, 200);
      assert.equal(begin.body.chunks, 1);
      assert.equal((await t.download(a, HASH_B)).status, 404);
      assert.equal((await t.json(`/account/files/${HASH_B}/complete`, a, {})).status, 400);
      const bad = await fetch(`${t.base}/account/files/${HASH_B}/0`, { method: 'PUT', headers: { Authorization: `Bearer ${a}`, 'Content-Type': 'application/octet-stream' }, body: bytesOf(999) });
      assert.equal(bad.status, 400);
      assert.equal((await t.upload(a, HASH_B, bytesOf(1000))).status, 200);
      const big = await t.json('/account/files/1-0000000000000001', a, { size: 2600, mime: 'audio/mp4' });
      assert.equal(big.status, 413); assert.equal(big.body.code, 'TOO_LARGE');
      const quota = await t.json('/account/files/2-0000000000000002', a, { size: 2400, mime: 'audio/mp4' });
      assert.equal(quota.status, 413); assert.equal(quota.body.code, 'QUOTA');
      assert.equal((await t.json('/account/files/not-a-hash', a, { size: 10 })).status, 400);
    } finally { await t.close(); }
  });

  test(`${engine}: saving the library prunes files no playlist references`, async () => {
    const t = await boot(engine);
    try {
      const a = await t.user('files-d');
      await t.upload(a, HASH_A, bytesOf(10));
      await t.upload(a, HASH_B, bytesOf(20, 7));
      const keep = { id: 'p', name: '歌单', tracks: [{ id: `hash:${HASH_A}`, title: 'A', artist: '', hash: HASH_A }] };
      assert.equal((await t.json('/account/library', a, { revision: 0, playlists: [keep] }, 'PUT')).status, 200);
      await new Promise(r => setTimeout(r, 50));
      const check = (await t.json('/account/files/check', a, { hashes: [HASH_A, HASH_B] })).body;
      assert.deepEqual(check.present, [HASH_A]);
    } finally { await t.close(); }
  });
}
