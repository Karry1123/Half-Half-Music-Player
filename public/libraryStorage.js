import * as web from './libraryStorageWeb.js';
import * as native from './libraryStorageNative.js';
import { nativePlugin } from './nativeBridge.js';
export { fingerprint, extOf, fileNameOf, LibraryError } from './libraryStorageWeb.js';
export const isNative = globalThis.Capacitor?.getPlatform?.() === 'android';
const backend = isNative ? native : web;
// Migrate old APK IndexedDB libraries once, resumably. Keep the old data as backup.
let ready;
async function initialize() {
  if (!isNative) return;
  const cap = globalThis.Capacitor;
  const fs = nativePlugin('Filesystem');
  try { await fs.stat({ path: 'library-v1/migrated', directory: 'DATA' }); return; }
  catch (e) { if (!/does not exist|not exist|not found|ENOENT/i.test(e.message || '')) throw e; }
  const tracks = await web.listTracks();
  for (const t of tracks) {
    if (await native.findByHash(t.hash)) continue;
    const blob = await web.getBlob(t.id);
    if (!blob) throw new Error(`旧曲库音频缺失：${t.title}`);
    const cover = await web.coverUrl(t);
    const coverBlob = cover ? await fetch(cover).then(r => r.ok ? r.blob() : null).catch(() => null) : null;
    await native.saveTrack(blob, { ...t, cover: coverBlob || t.coverUrl, fileName: web.fileNameOf(t) });
  }
  await fs.writeFile({ path: 'library-v1/migrated', directory: 'DATA', data: '1', encoding: 'utf8', recursive: true });
}
const call = name => async (...args) => {
  ready ??= initialize().catch(e => { ready = null; throw e; });
  await ready;
  return backend[name](...args);
};
export const isSupported = backend.isSupported;
export const subscribe = backend.subscribe;
export const canPickFiles = backend.canPickFiles;
export const canPickFolder = backend.canPickFolder;
export const saveTrack = call('saveTrack');
export const listTracks = call('listTracks');
export const getTrack = call('getTrack');
export const findByHash = call('findByHash');
export const findBySource = call('findBySource');
export const getBlob = call('getBlob');
export const coverUrl = call('coverUrl');
export const setCover = call('setCover');
export const updateTrack = call('updateTrack');
export const markPlayed = call('markPlayed');
export const deleteTrack = call('deleteTrack');
export const clearAll = call('clearAll');
export const usage = call('usage');
export const requestPersist = call('requestPersist');
export const exportTrack = call('exportTrack');
export const exportAll = call('exportAll');
export const exportBlob = isNative ? call('exportBlob') : undefined;
export const listPlaylists = call('listPlaylists');
export const putPlaylist = call('putPlaylist');
export const deletePlaylist = call('deletePlaylist');
