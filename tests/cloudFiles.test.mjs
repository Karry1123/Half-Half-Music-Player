import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudUploader, needsUpload } from '../public/cloudFiles.js';

const CHUNK = 4;
/** 假的账号服务：记录 check / begin / chunk / complete 调用 */
function fakeClient({ present = [], quota = 1000, maxFile = 100 } = {}) {
  const calls = [], files = new Map();
  const client = {
    base: 'http://svc', token: 't', required: true, user: { isActivated: true },
    async request(path, body) {
      calls.push([path, body]);
      if (path === '/account/files/check') return { present: [...present, ...files.keys()], used: 0, quota, maxFile, chunkSize: CHUNK };
      const m = /^\/account\/files\/([^/]+)(\/complete)?$/.exec(path);
      if (m && !m[2]) {
        if (body.size > maxFile) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE', status: 413 });
        files.set(m[1], { size: body.size, chunks: [] });
        return { complete: false, chunkSize: CHUNK, chunks: Math.ceil(body.size / CHUNK) };
      }
      if (m && m[2]) { files.get(m[1]).complete = true; return { ok: true, size: files.get(m[1]).size }; }
      throw new Error(`unexpected ${path}`);
    },
  };
  return { client, calls, files };
}

test('needsUpload picks local imports with a fingerprint only', () => {
  assert.equal(needsUpload({ id: 'a', hash: 'h', source: 'local' }), true);
  assert.equal(needsUpload({ id: 'b', hash: 'h', sourceId: 'youtube:x', source: 'youtube' }), false);
  assert.equal(needsUpload({ id: 'c', source: 'local' }), false);
  assert.equal(needsUpload({ id: 'd', hash: 'h', source: 'bilibili' }), false);
});

test('uploader sends missing local files in chunks, skips ones the cloud already has and reports once', async () => {
  const { client, calls, files } = fakeClient({ present: ['have'] });
  const puts = [];
  globalThis.fetch = async (url, init) => { puts.push([url, init.body.size]); return { ok: true }; };
  const tracks = [
    { id: '1', hash: 'have', source: 'local', title: 'Old' },
    { id: '2', hash: 'new1', source: 'local', title: 'New', artist: 'Band' },
    { id: '3', hash: 'yt', sourceId: 'youtube:a', source: 'youtube' },
  ];
  const notes = [];
  const up = createCloudUploader({ client, storage: { listTracks: async () => tracks, getBlob: async (id) => (id === '2' ? new Blob(['123456789']) : null) }, notify: (m) => notes.push(m) });
  const r = await up.run();
  assert.deepEqual(r, { uploaded: 1, skipped: 0 });
  assert.deepEqual(calls[0], ['/account/files/check', { hashes: ['have', 'new1'] }]);
  assert.equal(calls[1][0], '/account/files/new1');
  assert.deepEqual(puts.map(([u, n]) => [u.replace('http://svc', ''), n]), [['/account/files/new1/0', 4], ['/account/files/new1/1', 4], ['/account/files/new1/2', 1]]);
  assert.equal(files.get('new1').complete, true);
  assert.deepEqual(notes, ['已把 1 首本机导入的歌上传到云端，其他设备可以直接下载']);
  // 第二轮：云端已经有了，什么都不传
  const again = await up.run();
  assert.deepEqual(again, { uploaded: 0, skipped: 0 });
  assert.equal(puts.length, 3);
});

test('uploader remembers failures for the session and does not retry them', async () => {
  const { client } = fakeClient({ maxFile: 5 });
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return { ok: true }; };
  const tracks = [{ id: '1', hash: 'big', source: 'local', title: 'Big' }, { id: '2', hash: 'gone', source: 'local', title: 'Gone' }];
  const up = createCloudUploader({ client, storage: { listTracks: async () => tracks, getBlob: async (id) => (id === '1' ? new Blob(['0123456789']) : null) } });
  assert.deepEqual(await up.run(), { uploaded: 0, skipped: 2 });
  assert.equal(fetches, 0);
  assert.match(up.failures().get('big'), /单文件上限/);
  assert.match(up.failures().get('gone'), /没有这首歌的文件/);
  assert.deepEqual(await up.run(), { uploaded: 0, skipped: 0 });
});

test('uploader is disabled without an activated account', async () => {
  const { client } = fakeClient();
  client.user = { isActivated: false };
  const up = createCloudUploader({ client, storage: { listTracks: () => assert.fail('must not touch storage') } });
  assert.equal(await up.run(), null);
});
