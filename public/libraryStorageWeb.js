// libraryStorage.js — 浏览器本地曲库（IndexedDB）
//
// 手机浏览器没法往文件夹里写文件，所以"下载"的歌曲存在 IndexedDB 里：
// 音频 Blob + 封面 Blob + 元数据，下次打开页面自动恢复，离线也能播放。
// 不依赖任何库，也不依赖 React：任何框架都可以 import 后直接用。
//
// ┌─ tracks  { id, hash, title, artist, album, duration, size, mime, ext, quality,
// │            source, sourceLabel, sourceId, pageUrl, coverUrl, hasCover, addedAt, lastPlayedAt, playCount }
// ├─ blobs   { id, blob }            音频本体
// └─ covers  { id, blob }            封面
// 元数据和音频分表：列出曲库时只读元数据，不会把几百 MB 音频一次性读进内存。
//
// 识别"已经下载过"：hash 是对文件内容取样计算的指纹（大小 + 头/中/尾各 256KB），
// 与文件名无关；同一首歌在电脑和手机上算出来一样，所以两台设备之间也能认出"对方的这首我已经有了"。
// 不用 crypto.subtle：手机通过 http://局域网IP 打开时不是安全上下文，crypto.subtle 不可用。
//
// 兼容性：
//   - 少数旧版 Safari 存 Blob 会失败，自动改存 ArrayBuffer，读出时还原成 Blob
//   - Safari 对"7 天没打开过"的网站会清空脚本存储；请求 navigator.storage.persist()，
//     并建议 iOS 用户"添加到主屏幕"（主屏幕 Web App 不受 7 天限制）
//   - 导出：桌面 Chromium 用 File System Access（可选保存位置 / 整个文件夹），其余浏览器用 <a download>

const DB_NAME = 'halfhalf-library';
// v2: + playlists { id, name, coverUrl, createdAt, updatedAt, trackIds[], system? }（歌单只引用 tracks.id，删歌单不删音频）
const DB_VERSION = 2;
const SAMPLE = 256 * 1024;

// ───────────────────────────── 底层：IndexedDB 的 Promise 封装

let dbPromise = null;

export function isSupported() {
  return typeof indexedDB !== 'undefined';
}

function openDb() {
  if (!isSupported()) return Promise.reject(new LibraryError('UNSUPPORTED', '当前浏览器不支持 IndexedDB（隐私模式下的部分浏览器会禁用）'));
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) {
        const t = db.createObjectStore('tracks', { keyPath: 'id' });
        t.createIndex('hash', 'hash', { unique: true });
        t.createIndex('sourceId', 'sourceId');
        t.createIndex('addedAt', 'addedAt');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('covers')) db.createObjectStore('covers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // 另一个标签页升级了数据库版本：关掉旧连接，下次调用时重新打开
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(new LibraryError('OPEN_FAILED', `无法打开本地曲库：${req.error?.message || req.error}`));
    };
    req.onblocked = () => console.warn('[library] 数据库升级被其他标签页阻塞，请关闭其他 Half&Half 页面');
  });
  return dbPromise;
}

const promisify = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** 在一个事务里执行 fn，事务真正提交后才 resolve（比单个请求 onsuccess 更可靠） */
async function tx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(toLibraryError(t.error));
    t.onabort = () => reject(toLibraryError(t.error || new Error('事务被中止')));
    Promise.resolve(fn(...[stores].flat().map((s) => t.objectStore(s))))
      .then((r) => (result = r))
      .catch((e) => {
        try {
          t.abort();
        } catch {}
        reject(toLibraryError(e));
      });
  });
}

export class LibraryError extends Error {
  /** @param {'UNSUPPORTED'|'OPEN_FAILED'|'QUOTA'|'NOT_FOUND'|'WRITE_FAILED'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function toLibraryError(e) {
  if (e instanceof LibraryError) return e;
  if (e?.name === 'QuotaExceededError') return new LibraryError('QUOTA', '浏览器存储空间不足：删除一些本地歌曲后再试');
  return new LibraryError('WRITE_FAILED', e?.message || String(e));
}

// ───────────────────────────── 指纹

/** 两路 32 位乘法哈希（cyrb53 思路）→ 16 位十六进制，纯 JS，任何上下文都可用 */
function hash64(bytes, h1 = 0xdeadbeef, h2 = 0x41c6ce57) {
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return [h1, h2];
}

/**
 * 内容指纹：文件大小 + 头 / 中 / 尾 各 256KB。几 MB 的音频只读 768KB，手机上也在毫秒级。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function fingerprint(blob) {
  const n = blob.size;
  const parts = n <= SAMPLE * 3 ? [blob] : [blob.slice(0, SAMPLE), blob.slice(n / 2 - SAMPLE / 2, n / 2 + SAMPLE / 2), blob.slice(n - SAMPLE)];
  let h = [n >>> 0, Math.floor(n / 2 ** 32)];
  for (const p of parts) h = hash64(new Uint8Array(await p.arrayBuffer()), h[0] ^ 0x9e3779b9, h[1]);
  return `${n.toString(36)}-${(h[0] >>> 0).toString(16).padStart(8, '0')}${(h[1] >>> 0).toString(16).padStart(8, '0')}`;
}

// ───────────────────────────── Blob 存取（含旧 Safari 兼容）

let blobsUnsupported = false;

async function putBinary(store, id, blob) {
  if (!blobsUnsupported) {
    try {
      await tx(store, 'readwrite', (s) => promisify(s.put({ id, blob })));
      return;
    } catch (e) {
      if (e.code === 'QUOTA') throw e;
      // 旧版 Safari："Error preparing Blob/File data to be stored in object store"
      console.warn('[library] 无法直接存 Blob，改存 ArrayBuffer：', e.message);
      blobsUnsupported = true;
    }
  }
  const buf = await blob.arrayBuffer();
  await tx(store, 'readwrite', (s) => promisify(s.put({ id, buf, type: blob.type })));
}

async function getBinary(store, id) {
  const rec = await tx(store, 'readonly', (s) => promisify(s.get(id)));
  if (!rec) return null;
  return rec.blob || new Blob([rec.buf], { type: rec.type || '' });
}

// ───────────────────────────── 变更通知（同页 + 跨标签页）

const listeners = new Set();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('halfhalf-library') : null;
channel?.addEventListener('message', (e) => listeners.forEach((fn) => fn(e.data)));

function emit(event) {
  listeners.forEach((fn) => fn(event));
  channel?.postMessage(event);
}

/**
 * 订阅曲库变化：{ type: 'added'|'updated'|'deleted'|'cleared', id? }
 * @returns {() => void} 取消订阅
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ───────────────────────────── 封面

const coverUrls = new Map(); // id → objectURL（同一张封面只创建一次）

/** 远程封面尽量存成 Blob（离线可用）；跨域不允许时只保留 URL */
async function fetchCover(cover) {
  if (!cover) return null;
  if (cover instanceof Blob) return cover;
  if (typeof cover !== 'string') return null;
  if (cover.startsWith('data:') || cover.startsWith('blob:') || /^https?:/.test(cover)) {
    try {
      const r = await fetch(cover, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout?.(6000) });
      const b = r.ok ? await r.blob() : null;
      return b?.type.startsWith('image/') && b.size < 5 * 1024 * 1024 ? b : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 曲目封面的可显示地址：本地存了就用 objectURL，否则用原始 URL */
export async function coverUrl(track) {
  if (!track?.hasCover) return track?.coverUrl || null;
  if (coverUrls.has(track.id)) return coverUrls.get(track.id);
  const b = await getBinary('covers', track.id).catch(() => null);
  if (!b) return track.coverUrl || null;
  const url = URL.createObjectURL(b);
  coverUrls.set(track.id, url);
  return url;
}

// ───────────────────────────── 公共 API

const EXT = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/webm': 'webm',
};
export const extOf = (mime, name) => (name && /\.([a-z0-9]{2,5})$/i.exec(name)?.[1].toLowerCase()) || EXT[(mime || '').split(';')[0]] || 'm4a';

const newId = () => (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/**
 * 保存一首歌。按内容指纹去重：已经存过同一个文件时直接返回已有记录。
 * @param {Blob} blob 音频
 * @param {{ id?: string, title: string, artist?: string, album?: string, duration?: number, quality?: string,
 *           source?: string, sourceLabel?: string, sourceId?: string, pageUrl?: string,
 *           cover?: string|Blob, fileName?: string, hash?: string }} meta
 * @returns {Promise<{ track: object, existed: boolean }>}
 */
export async function saveTrack(blob, meta) {
  if (!(blob instanceof Blob) || !blob.size) throw new LibraryError('WRITE_FAILED', '不是有效的音频文件');
  const hash = meta.hash || (await fingerprint(blob));
  const existing = await findByHash(hash);
  if (existing) return { track: existing, existed: true };

  const id = meta.id || newId();
  const coverBlob = await fetchCover(meta.cover);
  const track = {
    id,
    hash,
    title: String(meta.title || meta.fileName || '未命名').slice(0, 300),
    artist: String(meta.artist || '').slice(0, 200),
    album: meta.album || null,
    duration: Number(meta.duration) || null,
    size: blob.size,
    mime: blob.type || null,
    ext: extOf(blob.type, meta.fileName),
    quality: meta.quality || null,
    source: meta.source || 'local',
    sourceLabel: meta.sourceLabel || '本地',
    sourceId: meta.sourceId || null,
    pageUrl: meta.pageUrl || null,
    coverUrl: typeof meta.cover === 'string' && /^https?:/.test(meta.cover) ? meta.cover : null,
    hasCover: !!coverBlob,
    addedAt: Date.now(),
    lastPlayedAt: null,
    playCount: 0,
  };

  // 先写音频再写元数据：中途失败（空间不足）不会留下"有记录没文件"的坏条目
  await putBinary('blobs', id, blob);
  try {
    if (coverBlob) await putBinary('covers', id, coverBlob);
    await tx('tracks', 'readwrite', (s) => promisify(s.add(track)));
  } catch (e) {
    await tx(['blobs', 'covers'], 'readwrite', (b, c) => (b.delete(id), c.delete(id))).catch(() => {});
    if (e?.name === 'ConstraintError' || /constraint/i.test(e?.message)) {
      // 另一个标签页刚好同时存了同一个文件
      return { track: await findByHash(hash), existed: true };
    }
    throw toLibraryError(e);
  }
  emit({ type: 'added', id });
  return { track, existed: false };
}

/**
 * 列出全部曲目（只含元数据）。
 * @param {{ sort?: 'addedAt'|'title'|'artist'|'size'|'duration'|'lastPlayedAt', order?: 'asc'|'desc' }} [opts]
 */
export async function listTracks({ sort = 'addedAt', order = 'desc' } = {}) {
  const all = await tx('tracks', 'readonly', (s) => promisify(s.getAll()));
  const dir = order === 'asc' ? 1 : -1;
  const key = (t) => t[sort] ?? (typeof t[sort] === 'string' ? '' : 0);
  return all.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return (typeof x === 'string' ? x.localeCompare(y, 'zh-Hans-CN') : x - y) * dir;
  });
}

export async function getTrack(id) {
  return (await tx('tracks', 'readonly', (s) => promisify(s.get(id)))) || null;
}

export async function findByHash(hash) {
  if (!hash) return null;
  return (await tx('tracks', 'readonly', (s) => promisify(s.index('hash').get(hash)))) || null;
}

/** 同一个平台条目（如 bilibili:BV1xx）是否下载过 */
export async function findBySource(sourceId) {
  if (!sourceId) return null;
  return (await tx('tracks', 'readonly', (s) => promisify(s.index('sourceId').get(sourceId)))) || null;
}

/** 读取音频 Blob；不存在返回 null */
export function getBlob(id) {
  return getBinary('blobs', id);
}

/** 只改元数据（时长、播放次数等），不能改 id / hash / size */
export async function updateTrack(id, patch) {
  const { id: _i, hash: _h, size: _s, ...safe } = patch;
  const t = await tx('tracks', 'readwrite', async (s) => {
    const cur = await promisify(s.get(id));
    if (!cur) return null;
    const next = { ...cur, ...safe };
    await promisify(s.put(next));
    return next;
  });
  if (t) emit({ type: 'updated', id });
  return t;
}

export function markPlayed(id) {
  return tx('tracks', 'readwrite', async (s) => {
    const cur = await promisify(s.get(id));
    if (cur) await promisify(s.put({ ...cur, lastPlayedAt: Date.now(), playCount: (cur.playCount || 0) + 1 }));
  }).catch(() => {});
}

export async function deleteTrack(id) {
  await tx(['tracks', 'blobs', 'covers'], 'readwrite', (t, b, c) => Promise.all([t.delete(id), b.delete(id), c.delete(id)].map(promisify)));
  if (coverUrls.has(id)) URL.revokeObjectURL(coverUrls.get(id));
  coverUrls.delete(id);
  emit({ type: 'deleted', id });
}

export async function clearAll() {
  await tx(['tracks', 'blobs', 'covers'], 'readwrite', (t, b, c) => Promise.all([t.clear(), b.clear(), c.clear()].map(promisify)));
  coverUrls.forEach((u) => URL.revokeObjectURL(u));
  coverUrls.clear();
  emit({ type: 'cleared' });
}

// ───────────────────────────── 歌单（只存 tracks.id 的引用；逻辑在 playlists.js）

export async function listPlaylists() {
  return tx('playlists', 'readonly', (s) => promisify(s.getAll()));
}

export async function putPlaylist(playlist) {
  await tx('playlists', 'readwrite', (s) => promisify(s.put(playlist)));
  emit({ type: 'playlist', id: playlist.id });
}

export async function deletePlaylist(id) {
  await tx('playlists', 'readwrite', (s) => promisify(s.delete(id)));
  emit({ type: 'playlist', id, deleted: true });
}

// ───────────────────────────── 存储空间

/**
 * @returns {Promise<{ used: number, quota: number|null, persisted: boolean, tracks: number, trackBytes: number }>}
 */
export async function usage() {
  const tracks = await listTracks().catch(() => []);
  const est = (await navigator.storage?.estimate?.().catch(() => null)) || {};
  return {
    used: est.usage ?? null,
    quota: est.quota ?? null,
    persisted: (await navigator.storage?.persisted?.().catch(() => false)) || false,
    tracks: tracks.length,
    trackBytes: tracks.reduce((a, t) => a + (t.size || 0), 0),
  };
}

/** 申请持久化存储（不会被浏览器在空间紧张时自动清理）。Chrome 对常用站点 / 已安装应用通常直接同意 */
export async function requestPersist() {
  try {
    return (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false;
  } catch {
    return false;
  }
}

// ───────────────────────────── 导出为真实文件

const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'track';
export const fileNameOf = (t) => `${safeName(t.artist && !t.title.includes(t.artist) ? `${t.artist} - ${t.title}` : t.title)}.${t.ext || 'm4a'}`;

/** 能不能弹出"另存为" / 选择文件夹（桌面 Chromium，且必须是安全上下文） */
export const canPickFiles = () => typeof window !== 'undefined' && 'showSaveFilePicker' in window && window.isSecureContext;
export const canPickFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window && window.isSecureContext;

function anchorDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name, rel: 'noopener' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  // iOS Safari 需要 URL 多存活一会儿才能完成保存
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * 导出单首为本地文件。必须在用户点击的事件里调用（浏览器要求用户手势）。
 * @returns {Promise<'saved'|'downloaded'|'cancelled'>}
 */
export async function exportTrack(id, { picker = canPickFiles() } = {}) {
  const [t, blob] = await Promise.all([getTrack(id), getBlob(id)]);
  if (!t || !blob) throw new LibraryError('NOT_FOUND', '本地曲库里找不到这首歌');
  const name = fileNameOf(t);
  if (picker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, startIn: 'music' });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return 'saved';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      console.warn('[library] 另存为失败，改用普通下载：', e);
    }
  }
  anchorDownload(blob, name);
  return 'downloaded';
}

/**
 * 全部导出。支持选文件夹时一次写入整个文件夹（同名文件跳过）；否则逐个触发下载（浏览器可能会询问"是否允许下载多个文件"）。
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{ written: number, skipped: number, mode: 'folder'|'downloads'|'cancelled' }>}
 */
export async function exportAll(onProgress) {
  const tracks = await listTracks({ sort: 'addedAt', order: 'asc' });
  if (canPickFolder()) {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'music', id: 'halfhalf-export' });
    } catch (e) {
      if (e?.name === 'AbortError') return { written: 0, skipped: 0, mode: 'cancelled' };
      throw e;
    }
    let written = 0;
    let skipped = 0;
    for (const [i, t] of tracks.entries()) {
      const name = fileNameOf(t);
      const exists = await dir.getFileHandle(name).then(() => true, () => false);
      if (exists) skipped++;
      else {
        const blob = await getBlob(t.id);
        if (blob) {
          const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
          await w.write(blob);
          await w.close();
          written++;
        }
      }
      onProgress?.(i + 1, tracks.length);
    }
    return { written, skipped, mode: 'folder' };
  }
  let written = 0;
  for (const [i, t] of tracks.entries()) {
    const blob = await getBlob(t.id);
    if (blob) {
      anchorDownload(blob, fileNameOf(t));
      written++;
      await new Promise((r) => setTimeout(r, 400)); // 连续触发太快会被浏览器吞掉
    }
    onProgress?.(i + 1, tracks.length);
  }
  return { written, skipped: 0, mode: 'downloads' };
}
