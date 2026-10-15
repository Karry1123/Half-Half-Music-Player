import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createPlaylistZip } from '../public/playlistZip.js';

test('ZIP preserves bytes, real extensions, duplicate names and ordered metadata', async () => {
  const tracks = [1, 2].map(id => ({ id: String(id), title: '同名歌曲', artist: '歌手', ext: 'm4a', size: 3 }));
  const blob = await createPlaylistZip({ name: '我的歌单', tracks, getBlob: async id => new Blob([`abc${id}`]) });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const metadata = JSON.parse(await zip.file('metadata.json').async('string'));
  assert.equal(metadata.name, '我的歌单'); assert.equal(metadata.tracks.length, 2);
  assert.notEqual(metadata.tracks[0].filename, metadata.tracks[1].filename);
  for (let i = 0; i < 2; i++) {
    assert.match(metadata.tracks[i].filename, /\.m4a$/);
    assert.equal(await zip.file(metadata.tracks[i].filename).async('string'), `abc${i + 1}`);
  }
});
test('ZIP rejects missing audio and oversized selections without fake success', async () => {
  await assert.rejects(createPlaylistZip({ tracks: [{ id: 'a', title: 'missing' }], getBlob: async () => null }), /未缓存/);
  await assert.rejects(createPlaylistZip({ tracks: [{ size: 513 * 1024 * 1024 }], getBlob: async () => null }), /512 MB/);
});
