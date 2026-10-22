// Android: metadata + audio in Directory.Data. No public-storage permission required.
// Chunked bridge writes avoid making one huge base64 string for long recordings.
import { fingerprint, extOf, fileNameOf } from './libraryStorageWeb.js';
import { nativePlugin } from './nativeBridge.js';
import { fetchCover } from './coverUrl.js';
const cap = () => globalThis.Capacitor;
const fs = () => nativePlugin('Filesystem');
const directory = 'DATA';
const root = 'library-v1';
const listeners = new Set();
const pathFor = id => `${root}/${encodeURIComponent(id)}`;
const notify = event => listeners.forEach(fn => fn(event));
let queue = Promise.resolve();
const serial = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
const missing = e => /does not exist|not exist|not found|ENOENT/i.test(e.message || '');
async function remove(path) {
  try { await fs().deleteFile({ path, directory }); } catch (e) { if (!missing(e)) throw e; }
}
async function writeBlob(path, blob, dir = directory) {
  const chunk = 192 * 1024; // Multiple of three, so appended base64 chunks decode independently.
  for (let start = 0; start < blob.size; start += chunk) {
    const bytes = new Uint8Array(await blob.slice(start, start + chunk).arrayBuffer());
    let raw = '';
    for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const options = { path, directory: dir, data: btoa(raw), recursive: true };
    await (start ? fs().appendFile(options) : fs().writeFile(options));
  }
}
async function readJson(path) {
  try { return JSON.parse((await fs().readFile({ path, directory, encoding: 'utf8' })).data); }
  catch (e) { if (missing(e)) return null; throw e; }
}
async function commit(track) {
  const path = `${pathFor(track.id)}.json`;
  await fs().writeFile({ path: `${path}.tmp`, directory, encoding: 'utf8', data: JSON.stringify(track), recursive: true });
  await fs().rename({ from: `${path}.tmp`, to: path, directory, toDirectory: directory });
}
export const isSupported = () => true;
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export async function listTracks({ sort = 'addedAt', order = 'desc' } = {}) {
  let files;
  try { files = (await fs().readdir({ path: root, directory })).files; }
  catch (e) { if (missing(e)) return []; throw e; }
  const tracks = (await Promise.all(files.filter(f => f.name.endsWith('.json')).map(f => readJson(`${root}/${f.name}`)))).filter(Boolean);
  return tracks.sort((a, b) => (typeof a[sort] === 'string' ? a[sort].localeCompare(b[sort] || '', 'zh-Hans-CN') : (a[sort] || 0) - (b[sort] || 0)) * (order === 'asc' ? 1 : -1));
}
export const getTrack = id => readJson(`${pathFor(id)}.json`);
export const findByHash = async hash => (await listTracks()).find(t => t.hash === hash) || null;
export const findBySource = async sourceId => (await listTracks()).find(t => t.sourceId === sourceId) || null;
export function saveTrack(blob, meta) {
  return serial(async () => {
    if (!(blob instanceof Blob) || !blob.size) throw new Error('不是有效的音频文件');
    const hash = meta.hash || await fingerprint(blob);
    const existing = await findByHash(hash);
    if (existing) return { track: existing, existed: true };
    // Never overwrite an existing record, even if an imported id collides.
    const id = crypto.randomUUID();
    const path = pathFor(id);
    const cover = await fetchCover(meta.cover || meta.coverUrl);
    const track = {
      id, hash, title: String(meta.title || meta.fileName || '未命名').slice(0, 300),
      artist: meta.artist || '', album: meta.album || null, duration: meta.duration || null,
      size: blob.size, mime: blob.type || 'audio/mpeg', ext: extOf(blob.type, meta.fileName),
      quality: meta.quality || null, source: meta.source || 'local', sourceLabel: meta.sourceLabel || '本地',
      sourceId: meta.sourceId || null, pageUrl: meta.pageUrl || null,
      coverUrl: typeof meta.cover === 'string' ? meta.cover : meta.coverUrl || null, hasCover: !!cover,
      addedAt: meta.addedAt || Date.now(), playCount: meta.playCount || 0, lastPlayedAt: meta.lastPlayedAt || null,
    };
    try {
      await writeBlob(`${path}.audio`, blob);
      if (cover) await writeBlob(`${path}.cover`, cover);
      await commit(track); // Metadata is visible only after all media is durable.
    } catch (e) {
      await Promise.allSettled(['.audio', '.cover', '.json.tmp'].map(ext => remove(path + ext)));
      throw e;
    }
    notify({ type: 'added', id });
    return { track, existed: false };
  });
}
export async function getBlob(id) {
  const track = await getTrack(id);
  if (!track) return null;
  const { uri } = await fs().getUri({ path: `${pathFor(id)}.audio`, directory });
  const r = await fetch(cap().convertFileSrc(uri));
  if (!r.ok) throw new Error('读取本地音频失败');
  return new Blob([await r.blob()], { type: track.mime });
}
export async function coverUrl(track) {
  if (!track?.hasCover) return track?.coverUrl || null;
  try {
    const path = `${pathFor(track.id)}.cover`;
    await fs().stat({ path, directory });
    const { uri } = await fs().getUri({ path, directory });
    return cap().convertFileSrc(uri);
  } catch (error) {
    if (!missing(error)) throw error;
    track.hasCover = false;
    await updateTrack(track.id, { hasCover: false });
    return track.coverUrl || null;
  }
}
export async function setCover(id, url) {
  const blob = await fetchCover(url);
  return serial(async () => {
    const current = await getTrack(id);
    if (!current) return null;
    if (blob) await writeBlob(`${pathFor(id)}.cover`, blob);
    const track = { ...current, coverUrl: url, hasCover: !!blob || current.hasCover };
    await commit(track);
    notify({ type: 'updated', id });
    return track;
  });
}
export function updateTrack(id, patch) {
  return serial(async () => {
    const current = await getTrack(id);
    if (!current) return null;
    const { id: _id, hash, size, ...safe } = patch;
    const track = { ...current, ...safe };
    await commit(track); notify({ type: 'updated', id }); return track;
  });
}
export const markPlayed = async id => {
  const t = await getTrack(id);
  if (t) await updateTrack(id, { lastPlayedAt: Date.now(), playCount: (t.playCount || 0) + 1 });
};
export function deleteTrack(id) {
  return serial(async () => {
    await remove(`${pathFor(id)}.json`);
    await Promise.all(['.audio', '.cover'].map(ext => remove(pathFor(id) + ext)));
    notify({ type: 'deleted', id });
  });
}
export async function clearAll() { for (const t of await listTracks()) await deleteTrack(t.id); }
// Playlists live outside library-v1/: listTracks() treats every *.json in there as a track.
const playlistsPath = 'playlists-v1.json';
async function writePlaylists(list) {
  await fs().writeFile({ path: `${playlistsPath}.tmp`, directory, encoding: 'utf8', data: JSON.stringify(list), recursive: true });
  await fs().rename({ from: `${playlistsPath}.tmp`, to: playlistsPath, directory, toDirectory: directory });
}
export const listPlaylists = async () => (await readJson(playlistsPath)) || [];
export function putPlaylist(playlist) {
  return serial(async () => {
    const list = (await listPlaylists()).filter(p => p.id !== playlist.id);
    await writePlaylists([...list, playlist]);
    notify({ type: 'playlist', id: playlist.id });
  });
}
export function deletePlaylist(id) {
  return serial(async () => {
    await writePlaylists((await listPlaylists()).filter(p => p.id !== id));
    notify({ type: 'playlist', id, deleted: true });
  });
}
export async function usage() {
  const tracks = await listTracks();
  const bytes = tracks.reduce((n, t) => n + t.size, 0);
  return { used: bytes, quota: null, persisted: true, tracks: tracks.length, trackBytes: bytes };
}
export const requestPersist = async () => true;
export const canPickFiles = () => false;
export const canPickFolder = () => false;
export async function exportTrack(id) {
  const track = await getTrack(id);
  if (!track) throw new Error('本地曲库里找不到这首歌');
  const path = `exports/${fileNameOf(track)}`;
  await fs().mkdir({ path: 'exports', directory: 'CACHE', recursive: true }).catch(() => {});
  await fs().copy({ from: `${pathFor(id)}.audio`, directory, to: path, toDirectory: 'CACHE' });
  const { uri } = await fs().getUri({ path, directory: 'CACHE' });
  await nativePlugin('FileOpener').open({ filePath: uri, contentType: track.mime });
  return 'opened';
}
// Hand an in-memory file (e.g. a playlist ZIP) to the system open-with / share sheet.
export async function exportBlob(blob, fileName, mime = blob.type || 'application/octet-stream') {
  const path = `exports/${fileName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')}`;
  await fs().deleteFile({ path, directory: 'CACHE' }).catch(() => {});
  await writeBlob(path, blob, 'CACHE');
  const { uri } = await fs().getUri({ path, directory: 'CACHE' });
  await nativePlugin('FileOpener').open({ filePath: uri, contentType: mime });
  return 'opened';
}
export async function exportAll() { throw new Error('Android 请逐首选择「导出」，再由系统应用保存或分享'); }
