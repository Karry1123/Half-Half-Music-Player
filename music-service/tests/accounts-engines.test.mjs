// The same account scenarios on every storage engine:
//   SQLite (local dev), PGlite (real PostgreSQL SQL), and the real `pg` driver over TCP via DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Accounts, wrapPostgres } from '../src/accounts.js';

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const engines = {
  sqlite: async () => ({ accounts: await Accounts.memory(), stop: async () => {} }),
  pglite: async () => {
    const pg = new PGlite();
    const accounts = new Accounts(wrapPostgres(pg, (fn) => pg.transaction((tx) => fn(wrapPostgres(tx))), () => pg.close()));
    await accounts.migrate();
    return { accounts, stop: async () => {} };
  },
  'pg over DATABASE_URL': async () => {
    const db = new PGlite(), port = await freePort();
    const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 10 });
    await server.start();
    const accounts = await Accounts.open({ url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable` });
    assert.equal(accounts.db.dialect, 'postgres');
    return { accounts, stop: async () => { await server.stop(); await db.close(); } };
  },
};

for (const [name, open] of Object.entries(engines)) {
  test(`${name}: public IDs and normalized nicknames migrate existing duplicate profiles safely`, async () => {
    const { accounts: a, stop } = await open();
    try {
      // Recreate the pre-migration columns with real existing rows and references.
      await a.db.exec('DROP INDEX users_short_id_unique');
      await a.db.exec('DROP INDEX profiles_nickname_normalized_unique');
      await a.db.exec('ALTER TABLE users DROP COLUMN short_id');
      await a.db.exec('ALTER TABLE profiles DROP COLUMN nickname_normalized');
      for (const [index, nickname] of ['Orange', 'orange', 'Orange (2)', 'ＯＲＡＮＧＥ'].entries()) {
        const id = `legacy-${index}`;
        await a.db.run('INSERT INTO users VALUES($1,$2,$3,$4,1,$5)', [id, `user-${index}`, 'password-hash', 'salt', index + 1]);
        await a.db.run('INSERT INTO profiles VALUES($1,$2,$3)', [id, nickname, index + 1]);
      }
      await a.db.run('INSERT INTO sessions VALUES($1,$2,$3)', ['existing-token-hash', 'legacy-1', Date.now() + 10000]);
      await a.db.run('INSERT INTO libraries VALUES($1,1,$2,$3)', ['legacy-1', '[]', 1]);
      await a.migrate();
      const users = await a.db.all('SELECT id, short_id FROM users ORDER BY id');
      assert.deepEqual(users.map(user => user.id), ['legacy-0', 'legacy-1', 'legacy-2', 'legacy-3']);
      assert.equal(new Set(users.map(user => user.short_id)).size, 4);
      for (const user of users) assert.match(user.short_id, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{7}$/);
      assert.equal((await a.profile('legacy-0')).nickname, 'Orange');
      assert.equal((await a.profile('legacy-1')).nickname, 'orange (3)');
      assert.equal((await a.profile('legacy-2')).nickname, 'Orange (2)');
      const before = await a.db.all('SELECT * FROM profiles ORDER BY user_id');
      await a.migrate();
      assert.deepEqual(await a.db.all('SELECT * FROM profiles ORDER BY user_id'), before);
      assert.deepEqual(await a.db.all('SELECT id, short_id FROM users ORDER BY id'), users);
      assert.equal((await a.one('SELECT user_id FROM sessions')).user_id, 'legacy-1');
      assert.equal((await a.library('legacy-1')).revision, 1);
      await assert.rejects(a.saveProfile('legacy-1', 'oRaNgE'), { status: 409, code: 'NICKNAME_TAKEN' });
      await assert.rejects(a.saveProfile('legacy-1', 'ＯＲＡＮＧＥ'), { status: 409, code: 'NICKNAME_TAKEN' });
      await a.saveProfile('legacy-0', 'ORANGE'); // own normalized nickname is allowed
      const newUser = await a.register('new-user', 'local-test-password');
      assert.match(newUser.user.shortId, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{7}$/);
      assert.equal((await a.user(newUser.token)).shortId, newUser.user.shortId);
      assert.equal((await a.searchUsers(newUser.user.id, users[0].short_id.toLowerCase()))[0].id, 'legacy-0');
      assert.equal((await a.searchUsers(newUser.user.id, 'user-1'))[0].id, 'legacy-1');
      assert.equal((await a.searchUsers(newUser.user.id, 'orange (2)'))[0].id, 'legacy-2');
      const results = await Promise.allSettled(['legacy-1', 'legacy-2'].map(id => a.saveProfile(id, 'Unique')));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.code, 'NICKNAME_TAKEN');
    } finally { await a.close(); await stop(); }
  });

  test(`${name}: activation persists across devices, invites are single use, logout revokes`, async () => {
    const { accounts: a, stop } = await open();
    try {
      await a.migrate(); // idempotent: a redeploy re-runs it against existing tables
      const first = await a.register('Alice', 'a-long-password-123');
      assert.equal(first.user.isActivated, false);
      await assert.rejects(a.register('alice', 'another-long-password'), { code: 'EXISTS' });
      await assert.rejects(a.user(first.token, true), { code: 'NOT_ACTIVATED' });
      const code = await a.invite();
      assert.equal((await a.activate(first.token, code)).isActivated, true);
      const second = await a.login('alice', 'a-long-password-123');
      assert.equal(second.user.isActivated, true, 'a new device needs no invite');
      const bob = await a.register('bob', 'another-long-password');
      await assert.rejects(a.activate(bob.token, code), { code: 'INVITE_INVALID' });
      assert.equal((await a.user(bob.token)).isActivated, false, 'failed activation leaves the account inactive');
      await assert.rejects(a.login('alice', 'wrong'), { code: 'AUTH' });
      await a.logout(first.token);
      await assert.rejects(a.user(first.token), { code: 'AUTH' });
      assert.equal((await a.user(second.token, true)).id, first.user.id);
    } finally { await a.close(); await stop(); }
  });

  test(`${name}: concurrent activations with one invite code have exactly one winner`, async () => {
    const { accounts: a, stop } = await open();
    try {
      const users = await Promise.all(['u-one', 'u-two', 'u-three'].map((n) => a.register(n, 'local-test-password')));
      const code = await a.invite();
      const results = await Promise.allSettled(users.map((u) => a.activate(u.token, code)));
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    } finally { await a.close(); await stop(); }
  });

  test(`${name}: cloud library revisions, isolation, grants and room tickets`, async () => {
    const { accounts: a, stop } = await open();
    try {
      const x = await a.register('user1', 'password-number-one'), y = await a.register('user2', 'password-number-two');
      const playlist = [{ id: 'p1', name: '歌单', tracks: [{ id: 't1', title: '歌曲', sourceId: 'bilibili:BV1', blob: 'must not persist' }] }];
      const saved = await a.saveLibrary(x.user.id, 0, playlist);
      assert.equal(saved.revision, 1);
      assert.equal(saved.playlists[0].tracks[0].blob, undefined);
      assert.deepEqual(await a.library(y.user.id), { revision: 0, playlists: [] });
      await assert.rejects(a.saveLibrary(x.user.id, 0, []), { code: 'CONFLICT' });
      const again = await a.saveLibrary(x.user.id, 1, [{ ...playlist[0], name: '改名' }]);
      assert.equal(again.revision, 2);
      await assert.rejects(a.saveLibrary(x.user.id, 1, []), { code: 'CONFLICT' }, 'stale device cannot overwrite');
      assert.deepEqual(await a.library(x.user.id), { revision: 2, playlists: again.playlists });
      await a.grant(x.user.id, 'bilibili:BV1');
      await a.grant(x.user.id, 'bilibili:BV1'); // idempotent
      assert.equal(await a.owns(x.user.id, 'bilibili:BV1'), true);
      assert.equal(await a.owns(y.user.id, 'bilibili:BV1'), false);
      assert.deepEqual([...(await a.ownedTracks(x.user.id))], ['bilibili:BV1']);
      await a.activate(x.token, await a.invite());
      const { ticket } = await a.ticket(x.user.id, '123456');
      assert.deepEqual(await a.verifyTicket(ticket, '123456'), { ok: true });
      await assert.rejects(a.verifyTicket(ticket, '654321'), { code: 'AUTH' });
    } finally { await a.close(); await stop(); }
  });
}

test('sslmode=require keeps encryption without verifying the private CA; verify-full stays strict', async () => {
  const { pgConnection } = await import('../src/accounts.js');
  assert.deepEqual(pgConnection('postgresql://u:p@db:5432/x?sslmode=require'), { connectionString: 'postgresql://u:p@db:5432/x', ssl: { rejectUnauthorized: false } });
  assert.deepEqual(pgConnection('postgresql://u:p@db:5432/x?sslmode=verify-full'), { connectionString: 'postgresql://u:p@db:5432/x?sslmode=verify-full' });
  assert.deepEqual(pgConnection('postgresql://u:p@db:5432/x'), { connectionString: 'postgresql://u:p@db:5432/x' });
});

test('nickname is shared by every device of the account; playlist deletion markers are kept', async () => {
  const a = await Accounts.memory();
  try {
    const u = await a.register('nick-user', 'local-test-password');
    assert.deepEqual(await a.profile(u.user.id), { nickname: '' });
    await assert.rejects(a.saveProfile(u.user.id, '   '), { code: 'INPUT' });
    assert.deepEqual(await a.saveProfile(u.user.id, '  海盐  汽水 '), { nickname: '海盐 汽水' });
    assert.deepEqual(await a.saveProfile(u.user.id, '月亮邮差'), { nickname: '月亮邮差' });
    assert.deepEqual(await a.profile(u.user.id), { nickname: '月亮邮差' });
    const saved = await a.saveLibrary(u.user.id, 0, [{ id: 'gone', deleted: true, updatedAt: 5, tracks: [{ id: 'x' }] }, { id: 'p', name: '歌单', createdAt: 1, updatedAt: 2, tracks: [] }]);
    assert.deepEqual(saved.playlists, [{ id: 'gone', deleted: true, updatedAt: 5 }, { id: 'p', name: '歌单', createdAt: 1, updatedAt: 2, tracks: [] }]);
  } finally { await a.close(); }
});
