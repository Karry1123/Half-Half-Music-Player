import test from 'node:test';
import assert from 'node:assert/strict';
import { Accounts } from '../src/accounts.js';
import { ListeningStats, createListeningSync } from '../../public/listeningStats.js';
import { artistSplitStore } from '../../public/artistSplit.js';

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
    artistSplitStore.decide(key, 'split', 5000);
    await phone.sync();
    phone.stop();
    assert.deepEqual((await accounts.listening(user.id, 'x-device-id')).artistDecisions, [{ key, answer: 'split', at: 5000 }]);
    artistSplitStore.merge([{ key, answer: 'keep', at: 4000 }]);
    assert.equal(artistSplitStore.all()[key], 'split', 'an older remote answer does not override a newer local one');
    const tablet = await device();
    let remote = 0;
    const stop = artistSplitStore.subscribe((changed, origin) => { if (origin === 'remote') remote++; });
    await accounts.recordListening(user.id, { deviceId: 'device-third', records: [], coListening: [], artistDecisions: [{ key, answer: 'keep', at: 9000 }] });
    await tablet.sync();
    tablet.stop(); stop();
    assert.equal(artistSplitStore.all()[key], 'keep', 'the newer answer from another device is applied');
    assert.equal(remote, 1);
  } finally { await accounts.close(); }
});
