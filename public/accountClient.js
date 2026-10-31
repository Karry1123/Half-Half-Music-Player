import { nativePlugin } from './nativeBridge.js';
export class AccountClient {
  friendsCache = new Map();
  friendsListeners = new Set();
  getCachedFriends() { return this.friendsCache.get(this.user?.id)?.value || []; }
  subscribeFriends(listener) { this.friendsListeners.add(listener); return () => this.friendsListeners.delete(listener); }
  async loadFriends({ force = false } = {}) {
    const id = this.user?.id, token = this.token;
    if (!id || !this.user.isActivated) return [];
    let entry = this.friendsCache.get(id);
    if (!entry) {
      entry = { value: [], at: 0 };
      this.friendsCache.set(id, entry);
      // Disk reads happen outside React render; never hold up the network refresh.
      entry.cached = this.read(`${this.key}.friends.${id}`).then(raw => {
        const value = JSON.parse(raw || 'null');
        if (!entry.at && Array.isArray(value)) {
          entry.value = value;
          entry.signature = JSON.stringify(value);
          if (this.user?.id === id && this.token === token) this.friendsListeners.forEach(fn => fn(value));
        }
      }).catch(() => {});
    }
    if (entry.running) {
      if (!force) return entry.running;
      await entry.running.catch(() => {});
      if (this.user?.id !== id || this.token !== token) return [];
    } else if (!force && entry.at && Date.now() - entry.at < 15000) return entry.value;
    entry.running = this.request('/account/friends').then(data => {
      const value = data.friends || data;
      if (!Array.isArray(value)) throw new Error('Invalid friends response');
      if (this.user?.id !== id || this.token !== token) return [];
      const signature = JSON.stringify(value);
      entry.at = Date.now();
      if (signature !== entry.signature) {
        entry.value = value; entry.signature = signature;
        this.friendsListeners.forEach(fn => fn(value));
        this.store(`${this.key}.friends.${id}`, signature).catch(() => {});
      }
      return entry.value;
    }).finally(() => { entry.running = null; });
    return entry.running;
  }
  constructor(base) { this.base = base; this.token = ''; this.user = null; this.required = true; this.revision = 0; this.playlists = []; }
  get key() { return `hh.account.${this.base}`; }
  async read(key) {
    return globalThis.Capacitor?.isNativePlatform?.() ? (await nativePlugin('Preferences').get({ key })).value : globalThis.localStorage?.getItem(key);
  }
  async store(key, value) {
    if (globalThis.Capacitor?.isNativePlatform?.()) {
      const prefs = nativePlugin('Preferences');
      if (value) await prefs.set({ key, value }); else await prefs.remove({ key });
    } else if (value) globalThis.localStorage?.setItem(key, value); else globalThis.localStorage?.removeItem(key);
  }
  async cacheUser() {
    if (!this.user?.id) return;
    await this.store(`${this.key}.user`, JSON.stringify(this.user));
    await this.store(`${this.key}.lastUserId`, this.user.id);
  }
  async persist(token) {
    if (globalThis.Capacitor?.isNativePlatform?.()) {
      const prefs = nativePlugin('Preferences');
      if (token) await prefs.set({ key: this.key, value: token }); else await prefs.remove({ key: this.key });
    } else if (token) localStorage.setItem(this.key, token); else localStorage.removeItem(this.key);
    this.token = token;
    if (!token) {
      this.friendsCache.clear();
      await this.store(`${this.key}.user`, '');
      await this.store(`${this.key}.lastUserId`, '');
    }
  }
  async request(path, body, method = body ? 'POST' : 'GET') {
    const r = await fetch(`${this.base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(this.token && { Authorization: `Bearer ${this.token}` }) }, ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
    const data = await r.json();
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { code: data.code, status: r.status,
      retryAfter: Math.max(0, Number(r.headers.get('Retry-After')) || 0) * 1000 });
    return data;
  }
  async init() {
    this.token = await this.read(this.key) || '';
    if (this.token) {
      try { this.user = JSON.parse(await this.read(`${this.key}.user`) || 'null'); } catch {}
      const id = this.user?.id || await this.read(`${this.key}.lastUserId`);
      if (id && !this.user) this.user = { id, isActivated: true };
    }
    // Cached identity unlocks local playback immediately, including a blackholed network.
    if (this.user) {
      this.refreshIdentity().catch(() => {});
      return;
    }
    await this.refreshIdentity();
  }
  async refreshIdentity() {
    const cfg = await this.request('/auth/config'); this.required = cfg.required !== false;
    if (!this.required) return;
    if (this.token) {
      try { this.user = await this.request('/auth/me'); await this.cacheUser(); }
      catch (e) { if (e.status !== 401) throw e; await this.persist(''); this.user = null; }
    }
  }
  async login(username, password, register = false) {
    const result = await this.request(register ? '/auth/register' : '/auth/login', { username, password });
    await this.persist(result.token); this.user = result.user;
    await this.cacheUser();
  }
  async activate(code) { this.user = await this.request('/auth/activate', { code }); await this.cacheUser(); }
  async logout() { try { await this.request('/auth/logout', {}); } finally { await this.persist(''); this.user = null; this.playlists = []; this.revision = 0; } }
  async pull() { const data = await this.request('/account/library'); this.revision = data.revision; this.playlists = data.playlists; return data.playlists; }
  async push(playlists) { const data = await this.request('/account/library', { revision: this.revision, playlists }, 'PUT'); this.revision = data.revision; this.playlists = data.playlists; }
  async assertActive() { if (!this.required) return; this.user = await this.request('/auth/me'); if (!this.user.isActivated) throw new Error('请先激活账号'); }
  async peerTicket(room) { if (!this.required) return ''; await this.assertActive(); return (await this.request('/account/peer-ticket', { room })).ticket; }
  async verifyPeer(ticket, room) { if (this.required) await this.request('/account/verify-peer', { ticket, room }); }
}

export const SOURCE_EXPIRED = '原音源已失效，无法下载，建议重新搜索源替换';
export const LOCAL_FILE_MISSING = '此曲目来自本地文件，云端没有它的音频，请在原设备打开应用让它上传，或在此设备导入原文件';
export async function cacheCloudTrack(track, { storage, download, downloadFile }) {
  let existing = track.sourceId ? await storage.findBySource(track.sourceId) : null;
  if (!existing && track.hash) existing = await storage.findByHash(track.hash);
  if (existing && await storage.getBlob(existing.id)) {
    const cover = track.coverUrl || track.cover;
    if (!existing.hasCover && cover && storage.setCover) {
      // A cloud playlist can carry artwork absent from an older local download.
      existing = await storage.setCover(existing.id, cover).catch(() => null) || existing;
    }
    return existing;
  }
  // 本地导入的歌没有平台音源：原设备把文件传到了账号云端的话，按指纹直接拉下来
  const result = !track.sourceId && !track.pageUrl
    ? await (track.hash && downloadFile ? downloadFile(track) : Promise.reject(new Error(LOCAL_FILE_MISSING)))
    : await download(track);
  // The cloud hash was computed on another device; a fresh download may be a different encode, so let storage re-hash it.
  const saved = await storage.saveTrack(result.blob, { ...track, id: undefined, hash: undefined, fileName: result.fileName, cover: result.cover || track.coverUrl || track.cover, source: track.sourceId?.split(':')[0] || 'local', sourceLabel: '云端歌单' });
  return saved.track;
}

// Bounded polling avoids a lost SSE event leaving the cache button spinning forever.
export async function downloadCloudTrack(client, track, onProgress = () => {}) {
  try {
    const data = await client.request('/api/download', { ...(track.sourceId ? { id: track.sourceId } : { url: track.pageUrl }), format: 'best', meta: { title: track.title, artist: track.artist } });
    let job = data.job, file = data.entry?.file || job?.file;
    onProgress(job?.progress || 0);
    const deadline = Date.now() + 180000;
    while (!file) {
      if (job?.status === 'error') throw Object.assign(new Error(job.error || '下载失败'), { code: job.code });
      if (!job?.id || Date.now() > deadline) throw new Error('下载超时，请稍后重试');
      await new Promise(r => setTimeout(r, 1000));
      job = await client.request(`/api/downloads/${encodeURIComponent(job.id)}`); file = job.status === 'done' ? job.file : null;
      onProgress(job.progress || 0);
    }
    onProgress(0.99);
    const r = await fetch(`${client.base}/files/${encodeURIComponent(file)}`, { headers: { Authorization: `Bearer ${client.token}` }, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`音频读取失败 (${r.status})`);
    return { blob: await r.blob(), fileName: file };
  } catch (e) {
    if (e.code === 'UNAVAILABLE' || /视频不存在|已删除|不可用|unavailable|not found|removed|deleted/i.test(e.message)) throw new Error(SOURCE_EXPIRED);
    throw e;
  }
}

// ───────────────────────── 账号云端音频（本地导入的歌在设备间传递；服务端见 music-service/src/trackFiles.js）

/** 这些指纹里哪些已经在云端 → { present: string[], used, quota, maxFile, chunkSize } */
export function checkCloudFiles(client, hashes) {
  return client.request('/account/files/check', { hashes });
}

/** 分块上传一个本机文件；onProgress 0..1。已在云端的文件直接返回 { skipped: true } */
export async function uploadLocalFile(client, blob, { hash, fileName, mime }, onProgress = () => {}) {
  const begin = await client.request(`/account/files/${encodeURIComponent(hash)}`, { size: blob.size, mime: mime || blob.type || 'audio/mp4', fileName: fileName || '' });
  if (begin.complete) { onProgress(1); return { skipped: true }; }
  const chunkSize = begin.chunkSize || 1024 * 1024;
  for (let seq = 0; seq * chunkSize < blob.size; seq++) {
    const r = await fetch(`${client.base}/account/files/${encodeURIComponent(hash)}/${seq}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${client.token}` },
      body: blob.slice(seq * chunkSize, (seq + 1) * chunkSize), signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) { const data = await r.json().catch(() => ({})); throw Object.assign(new Error(data.error || `上传失败 (${r.status})`), { code: data.code, status: r.status }); }
    onProgress(Math.min(0.99, ((seq + 1) * chunkSize) / blob.size));
  }
  await client.request(`/account/files/${encodeURIComponent(hash)}/complete`, {});
  onProgress(1);
  return { skipped: false };
}

/** 按指纹下载云端音频 → { blob, fileName }；没有时抛 NOT_FOUND */
export async function downloadCloudFile(client, track, onProgress = () => {}) {
  const r = await fetch(`${client.base}/account/files/${encodeURIComponent(track.hash)}`, { headers: { Authorization: `Bearer ${client.token}` }, signal: AbortSignal.timeout(300000) });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw Object.assign(new Error(r.status === 404 ? LOCAL_FILE_MISSING : data.error || `音频读取失败 (${r.status})`), { code: data.code || (r.status === 404 ? 'NOT_FOUND' : undefined), status: r.status });
  }
  const total = Number(r.headers.get('Content-Length')) || 0;
  const type = r.headers.get('Content-Type') || 'audio/mp4';
  const name = /filename\*=UTF-8''([^;]+)/.exec(r.headers.get('Content-Disposition') || '')?.[1];
  let blob;
  if (r.body?.getReader && total) {
    const reader = r.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      onProgress(Math.min(0.99, got / total));
    }
    blob = new Blob(parts, { type });
  } else blob = new Blob([await r.arrayBuffer()], { type });
  onProgress(1);
  return { blob, fileName: name ? decodeURIComponent(name) : `${track.hash}.m4a` };
}
