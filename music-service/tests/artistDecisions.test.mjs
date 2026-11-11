import test from 'node:test';
import assert from 'node:assert/strict';
import { Accounts, wrapPostgres } from '../src/accounts.js';
import { createRequire } from 'node:module';
import { ListeningStats, createListeningSync } from '../../public/listeningStats.js';
import { artistSplitStore } from '../../public/artistSplit.js';

test('custom names are stored, replaced, cleared, and validated', async () => {
  const accounts = await Accounts.memory();
  try {
    const { user } = await accounts.register('artist-names', 'local-test-password');
    const put = row => accounts.recordListening(user.id, { deviceId: 'device-phone', records: [], coListening: [], artistDecisions: [row] });
    const get = async () => (await accounts.listening(user.id)).artistDecisions[0];
    await put({ key: 'a & b', answer: 'split', at: 1, names: [' A ', 'B'] });
    assert.deepEqual(await get(), { key: 'a & b', answer: 'split', at: 1, names: ['A', 'B'] });
    await put({ key: 'a & b', answer: 'split', at: 2, names: ['C', 'D'] });
    await put({ key: 'a & b', answer: 'split', at: 2, names: ['E', 'F'] });
    assert.deepEqual((await get()).names, ['C', 'D']);
    await put({ key: 'a & b', answer: 'split', at: 3 });
    assert.deepEqual(await get(), { key: 'a & b', answer: 'split', at: 3 });
    await put({ key: 'a & b', answer: 'split', at: 4, names: ['E', 'F'] });
    await put({ key: 'a & b', answer: 'keep', at: 5 });
    assert.deepEqual(await get(), { key: 'a & b', answer: 'keep', at: 5 });
    for (const names of [null, 'A,B', [], ['A'], Array(7).fill('A'), ['', 'B'], ['  ', 'B'], [1, 'B'], ['A'.repeat(101), 'B']]) {
      await assert.rejects(put({ key: 'bad', answer: 'split', at: 10, names }), { status: 400 });
    }
    await assert.rejects(put({ key: 'bad', answer: 'keep', at: 10, names: ['A', 'B'] }), { status: 400 });
  } finally { await accounts.close(); }
});

for (const dialect of ['sqlite', 'postgres']) test(`${dialect} migrates artist decisions without names and can rerun`, async () => {
  let accounts;
  if (dialect === 'sqlite') accounts = await Accounts.memory();
  else {
    const { PGlite } = createRequire(new URL('../package.json', import.meta.url))('@electric-sql/pglite');
    const pg = new PGlite();
    accounts = new Accounts(wrapPostgres(pg, fn => pg.transaction(tx => fn(wrapPostgres(tx))), () => pg.close()));
    await accounts.migrate();
  }
  try {
    const { user } = await accounts.register('legacy-artists', 'local-test-password');
    await accounts.db.exec('DROP TABLE artist_decisions');
    await accounts.db.exec('CREATE TABLE artist_decisions(user_id TEXT NOT NULL REFERENCES users(id), artist_key TEXT NOT NULL, answer TEXT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY(user_id,artist_key))');
    await accounts.db.run('INSERT INTO artist_decisions VALUES($1,$2,$3,$4)', [user.id, 'a & b', 'split', 1]);
    await accounts.migrate();
    await accounts.migrate();
    assert.deepEqual((await accounts.listening(user.id)).artistDecisions, [{ key: 'a & b', answer: 'split', at: 1 }]);
    await accounts.recordListening(user.id, { deviceId: 'device-phone', records: [], coListening: [], artistDecisions: [{ key: 'a & b', answer: 'split', at: 2, names: ['C', 'D'] }] });
    assert.deepEqual((await accounts.listening(user.id)).artistDecisions[0].names, ['C', 'D']);
  } finally { await accounts.close(); }
});

test('artist decisions are stored per account, newest answer wins, and invalid input is rejected', async () => {
  const accounts = await Accounts.memory();
  try {
    const { user } = await accounts.register('artist-decisions', 'local-test-password');
    const { user: other } = await accounts.register('artist-other', 'local-test-password');
    const put = (userId, deviceId, artistDecisions) => accounts.recordListening(userId, { deviceId, records: [], coListening: [], artistDecisions });
    const get = async userId => (await accounts.listening(userId, 'device-reader')).artistDecisions.sort((a, b) => a.key.localeCompare(b.key));
    assert.deepEqual(await get(user.id), []);
    await put(user.id, 'device-phone', [{ key: 'a & b', answer: 'split', at: 1000 }, { key: 'c / d', answer: 'keep', at: 1000 }]);
    assert.deepEqual(await get(user.id), [{ key: 'a & b', answer: 'split', at: 1000 }, { key: 'c / d', answer: 'keep', at: 1000 }]);
    // The answering device also receives its own answers back (they are account-wide, not per device).
    assert.equal((await accounts.listening(user.id, 'device-phone')).artistDecisions.length, 2);
    // A newer answer from another device replaces it; an older or equal one does not.
    await put(user.id, 'device-tablet', [{ key: 'a & b', answer: 'keep', at: 2000 }]);
    await put(user.id, 'device-phone', [{ key: 'a & b', answer: 'split', at: 1500 }, { key: 'c / d', answer: 'split', at: 1000 }]);
    assert.deepEqual(await get(user.id), [{ key: 'a & b', answer: 'keep', at: 2000 }, { key: 'c / d', answer: 'keep', at: 1000 }]);
    // A clock far in the future is clamped to the server's time, so a later real answer still wins.
    await put(user.id, 'device-phone', [{ key: 'a & b', answer: 'split', at: Date.now() + 10 * 365 * 86400000 }]);
    const clamped = (await get(user.id))[0];
    assert.equal(clamped.answer, 'split');
    assert.ok(clamped.at <= Date.now());
    assert.deepEqual(await get(other.id), [], 'accounts are isolated');
    // Requests from older clients carry no decisions at all.
    await accounts.recordListening(user.id, { deviceId: 'device-phone', records: [], coListening: [] });
    for (const bad of ['x', [{ key: '', answer: 'split', at: 1 }], [{ key: 'k', answer: 'maybe', at: 1 }], [{ key: 'k', answer: 'split', at: -1 }],
      [{ key: 'k', answer: 'split', at: 1.5 }], [{ key: 'k', answer: 'split' }], [{ key: 'k'.repeat(401), answer: 'split', at: 1 }],
      [{ key: 'k', answer: 'split', at: 1 }, { key: 'k', answer: 'keep', at: 2 }], Array.from({ length: 201 }, (_, i) => ({ key: `k${i}`, answer: 'keep', at: 1 }))])
      await assert.rejects(put(user.id, 'device-phone', bad));
  } finally { await accounts.close(); }
});

test('an answer given on one device reaches another through the listening sync', async () => {
  const accounts = await Accounts.memory();
  try {
    const { user } = await accounts.register('artist-sync', 'local-test-password');
    const device = async () => {
      const stats = new ListeningStats({ userId: user.id, indexedDB: null });
      await stats.ready();
      const client = { user: { ...user, isActivated: true }, request: (path, body) =>
        path === '/account/plays' ? accounts.recordPlays(user.id, body) : body ? accounts.recordListening(user.id, body) : accounts.listening(user.id, decodeURIComponent(path.split('=')[1])) };
      return createListeningSync({ stats, client, listTracks: async () => [], shouldSync: () => false });
    };
    // Both "devices" share this process's store, so the second device is simulated by clearing it.
    const key = `calvin harris & dua lipa ${Date.now()}`;
    const phone = await device();
    artistSplitStore.decide(key, 'split', 5000, ['Calvin', 'Dua']);
    await phone.sync();
    phone.stop();
    assert.deepEqual((await accounts.listening(user.id, 'x-device-id')).artistDecisions, [{ key, answer: 'split', at: 5000, names: ['Calvin', 'Dua'] }]);
    artistSplitStore.merge([{ key, answer: 'keep', at: 4000 }]);
    assert.deepEqual(artistSplitStore.all()[key], { answer: 'split', names: ['Calvin', 'Dua'] }, 'an older remote answer does not override a newer local one');
    const tablet = await device();
    let remote = 0;
    const stop = artistSplitStore.subscribe((changed, origin) => { if (origin === 'remote') remote++; });
    await accounts.recordListening(user.id, { deviceId: 'device-third', records: [], coListening: [], artistDecisions: [{ key, answer: 'split', at: 8000, names: ['Calvin Harris', 'Dua Lipa'] }] });
    await tablet.sync();
    assert.deepEqual(artistSplitStore.all()[key], { answer: 'split', names: ['Calvin Harris', 'Dua Lipa'] });
    await accounts.recordListening(user.id, { deviceId: 'device-third', records: [], coListening: [], artistDecisions: [{ key, answer: 'keep', at: 9000 }] });
    await tablet.sync();
    tablet.stop(); stop();
    assert.equal(artistSplitStore.all()[key], 'keep', 'the newer answer from another device is applied');
    assert.equal(remote, 2);
  } finally { await accounts.close(); }
});
