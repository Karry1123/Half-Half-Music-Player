import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheCloudTrack } from '../public/accountClient.js';
test('cloud cache reuses local source and does not redownload audio', async () => {
  const existing = { id: 'local' };
  const result = await cacheCloudTrack({ sourceId: 'bilibili:BV1' }, { storage: { findBySource: async () => existing, getBlob: async () => new Blob(['audio']) }, download: () => { throw new Error('must not download'); } });
  assert.equal(result, existing);
});
test('cloud cache rejects local-only missing files and preserves download errors', async () => {
  const storage = { findByHash: async () => null, findBySource: async () => null };
  await assert.rejects(cacheCloudTrack({ hash: 'x' }, { storage }), /导入原文件/);
  await assert.rejects(cacheCloudTrack({ sourceId: 'bilibili:BV1' }, { storage, download: async () => { throw new Error('原音源已失效，无法下载，建议重新搜索源替换'); } }), /原音源已失效/);
});
test('cloud cache returns the stored track record, re-hashing the downloaded file', async () => {
  let meta;
  const storage = { findByHash: async () => null, findBySource: async () => null, saveTrack: async (_blob, m) => { meta = m; return { track: { ...m, id: 'new' }, existed: false }; } };
  const result = await cacheCloudTrack({ id: 'c1', sourceId: 'bilibili:BV1', hash: 'remote', title: 'T' }, { storage, download: async () => ({ blob: new Blob(['a']), fileName: 'a.m4a' }) });
  assert.equal(result.id, 'new');
  assert.equal(meta.hash, undefined);
  assert.equal(meta.source, 'bilibili');
});
