import test from 'node:test';
import assert from 'node:assert/strict';
// In-memory Capacitor bridge verifies write ordering, chunk boundaries and rollback.
const files = new Map();
let failCommit = false;
const missing = () => { throw new Error('does not exist'); };
const plugin = {
  async writeFile({ path, data, encoding }) { files.set(path, encoding ? data : Buffer.from(data, 'base64')); },
  async appendFile({ path, data }) { files.set(path, Buffer.concat([files.get(path), Buffer.from(data, 'base64')])); },
  async readFile({ path }) { if (!files.has(path)) missing(); return { data: files.get(path) }; },
  async readdir({ path }) { return { files: [...files.keys()].filter(p => p.startsWith(path + '/')).map(p => ({ name: p.slice(path.length + 1) })) }; },
  async rename({ from, to }) { if (failCommit) throw new Error('disk full'); files.set(to, files.get(from)); files.delete(from); },
  async deleteFile({ path }) { if (!files.delete(path)) missing(); },
};
// Match the native WebView bridge: it deliberately has no registerPlugin method.
globalThis.androidBridge = {};
globalThis.Capacitor = {
  PluginHeaders: [{ name: 'Filesystem', methods: Object.keys(plugin).map(name => ({ name, rtype: 'promise' })) }],
  nativePromise: (name, method, options) => plugin[method](options),
};
// Browser cross-tab notification is not relevant to native adapter unit tests.
globalThis.BroadcastChannel = undefined;
const storage = await import('../public/libraryStorageNative.js');

test('native storage chunk round-trip, concurrent deduplication, metadata preservation and delete', async () => {
  const data = new Uint8Array(400003).map((_, i) => i % 251);
  const blob = new Blob([data], { type: 'audio/mpeg' });
  const [a, b] = await Promise.all([storage.saveTrack(blob, { title: 'one' }), storage.saveTrack(blob, { title: 'two' })]);
  assert.equal(a.track.id, b.track.id); assert.equal(b.existed, true);
  assert.deepEqual([...files.values()].find(v => Buffer.isBuffer(v)), Buffer.from(data));
  await storage.updateTrack(a.track.id, { title: 'updated', id: 'wrong', size: 1 });
  const track = await storage.getTrack(a.track.id);
  assert.equal(track.size, data.length); assert.equal(track.title, 'updated');
  await storage.deleteTrack(track.id);
  assert.equal((await storage.listTracks()).length, 0);
  assert.equal(files.size, 0);
});

test('failed metadata commit leaves no visible track or partial media', async () => {
  failCommit = true;
  await assert.rejects(storage.saveTrack(new Blob(['song']), { title: 'failed' }), /disk full/);
  failCommit = false;
  assert.equal(files.size, 0);
});
