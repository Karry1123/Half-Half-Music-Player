import test from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
globalThis.androidBridge = {};
globalThis.Capacitor = {
  isNativePlatform: () => true,
  PluginHeaders: [{ name: 'Preferences', methods: ['get', 'set', 'remove'].map(name => ({ name, rtype: 'promise' })) }],
  nativePromise: async (_name, method, { key, value }) => {
    if (method === 'get') return { value: values.get(key) || null };
    if (method === 'set') values.set(key, value); else values.delete(key);
  },
};
const { AccountClient } = await import('../public/accountClient.js');

test('Capacitor Preferences restores offline identity and explicit logout removes it', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('airplane mode'); });
  const client = new AccountClient('https://native');
  client.request = async () => ({ token: 'native-token', user: { id: 'alice', isActivated: false } });
  await client.login('alice', 'password');
  client.request = async () => ({ id: 'alice', isActivated: true });
  await client.activate('invite');
  const restored = new AccountClient(client.base);
  await restored.init();
  assert.equal(restored.token, 'native-token');
  assert.deepEqual(restored.user, { id: 'alice', isActivated: true });
  values.delete(`${client.key}.user`);
  const fallback = new AccountClient(client.base);
  await fallback.init();
  assert.equal(fallback.user.id, 'alice');
  await assert.rejects(fallback.logout(), /airplane mode/);
  assert.equal(fallback.user, null);
  assert.equal(values.size, 0);
});
