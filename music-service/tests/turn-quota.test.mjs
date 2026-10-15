import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnQuotaGuard, setTurnQuotaGuard, fetchMonthlyTurnBytes } from '../../server/turnQuota.js';
import { iceConfigAsync } from '../../server/ice.js';

const quiet = { info() {}, warn() {}, error() {} };
const env = { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_ANALYTICS_TOKEN: 'analytics', TURN_QUOTA_GB: '1000' };
const response = bytes => ({ ok: true, json: async () => ({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: bytes } }] }] } } }) });
test('quota warnings and kill switch are persistent and once per UTC month', async () => {
  let saved, bytes = 499e9, now = Date.UTC(2026, 9, 15);
  const mail = [];
  const store = { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } };
  const options = { env, store, fetcher: async () => response(bytes), now: () => now, mailer: { sendMail: async value => mail.push(value) }, logger: quiet };
  const quota = await new TurnQuotaGuard(options).init();
  await quota.check(); assert.equal(mail.length, 0); assert.equal(quota.enabled(), true);
  bytes = 500e9; await quota.check(); await quota.check(); assert.equal(mail.length, 1);
  bytes = 900e9; await quota.check(); assert.equal(quota.enabled(), false); assert.equal(mail.length, 2);
  const restarted = await new TurnQuotaGuard(options).init();
  assert.equal(restarted.enabled(), false); await restarted.check(); assert.equal(mail.length, 2);
  bytes = 0; await restarted.check(); assert.equal(restarted.enabled(), false);
  now = Date.UTC(2026, 10, 1); await restarted.check(); assert.equal(restarted.enabled(), true);
  bytes = 900e9; await restarted.check(); assert.equal(mail.length, 4);
});
test('missing credentials, analytics errors and SMTP errors do not crash; kill precedes mail', async () => {
  const disabled = await new TurnQuotaGuard({ env: {}, logger: quiet }).init();
  await disabled.check(); assert.equal(disabled.enabled(), true);
  const quota = await new TurnQuotaGuard({ env, logger: quiet, store: { load: async () => null, save: async () => {} }, fetcher: async () => response(900e9), mailer: { sendMail: async () => { throw new Error('SMTP down'); } } }).init();
  await quota.check(); assert.equal(quota.enabled(), false);
  quota.fetcher = async () => { throw new Error('network'); };
  await quota.check(); assert.equal(quota.enabled(), false);
});
test('monthly analytics requests the whole month and rejects GraphQL errors', async () => {
  let body;
  assert.equal(await fetchMonthlyTurnBytes(env, async (_url, options) => { body = JSON.parse(options.body); return response(42); }, Date.UTC(2026, 9, 15)), 42);
  assert.equal(body.variables.dateFrom, '2026-10-01'); assert.equal(body.variables.dateTo, '2026-10-15');
  await assert.rejects(fetchMonthlyTurnBytes(env, async () => ({ ok: true, json: async () => ({ errors: [{ message: 'bad token' }] }) })));
});
test('kill switch excludes previously cached Cloudflare credentials and prevents new issuance', async t => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ iceServers: [{ urls: ['turn:cf.example:3478'], username: 'u', credential: 'p' }] }) }; };
  t.after(() => { globalThis.fetch = originalFetch; setTurnQuotaGuard(null); });
  setTurnQuotaGuard({ enabled: () => true });
  const cf = { CLOUDFLARE_TURN_KEY_ID: 'key', CLOUDFLARE_TURN_API_TOKEN: 'token' };
  assert.ok((await iceConfigAsync(cf)).some(s => [].concat(s.urls).includes('turn:cf.example:3478')));
  setTurnQuotaGuard({ enabled: () => false });
  assert.ok(!(await iceConfigAsync(cf)).some(s => [].concat(s.urls).includes('turn:cf.example:3478')));
  assert.equal(calls, 1);
});
