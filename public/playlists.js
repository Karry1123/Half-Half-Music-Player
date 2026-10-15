// playlists.js — 自定义歌单（纯逻辑 + 一个小 store；不依赖 DOM / React，Node 下可直接单测）
//
// 数据：
//   tracks     本机曲库（libraryStorage.js），歌单只引用 tracks.id
//   playlists  { id, name, coverUrl, createdAt, updatedAt, trackIds: string[], system? }
//
// 两个"系统歌单"：
//   ALL_ID   「全部已下载 / 已导入」：虚拟歌单，不存储，永远等于整个曲库
//   INBOX_ID 「默认曲库」：真实存储，不能删除 / 改名；下载、导入时选"稍后整理"就放这里。
//            第一次打开（还没有任何歌单数据）时，把已有的歌全部并入它 —— 旧版本用户的歌不会丢。
//
// 删除歌单只解绑引用，不删音频；从曲库删歌时，用 prune() 把它从所有歌单里摘掉。

export const ALL_ID = 'all';
export const INBOX_ID = 'inbox';
export const INBOX_NAME = '默认曲库';
export const ALL_NAME = '全部已下载 / 已导入';
export const MAX_NAME = 40;

export class PlaylistError extends Error {
  /** @param {'EMPTY_NAME'|'DUPLICATE'|'NOT_FOUND'|'SYSTEM'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isSystem = (p) => p?.id === INBOX_ID || p?.system === true;

/** 名称：去首尾空白、合并连续空白、截断到 40 字（按字符，不切坏 emoji） */
export function normalizeName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new PlaylistError('EMPTY_NAME', '歌单名不能为空');
  return [...s].slice(0, MAX_NAME).join('');
}

const sameName = (a, b) => a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'accent' }) === 0;

function assertUniqueName(list, name, exceptId) {
  if (sameName(name, ALL_NAME) || list.some((p) => p.id !== exceptId && sameName(p.name, name))) {
    throw new PlaylistError('DUPLICATE', `已经有叫「${name}」的歌单了`);
  }
}

const dedupe = (ids) => [...new Set(ids.filter((x) => typeof x === 'string' && x))];

export function makeInbox(trackIds = [], now = Date.now()) {
  return { id: INBOX_ID, name: INBOX_NAME, coverUrl: null, createdAt: now, updatedAt: now, trackIds: dedupe(trackIds), system: true };
}

/**
 * 读出的歌单 + 曲库现状 → 规范化的歌单列表（默认曲库排第一，其余按创建时间）。
 * 没有默认曲库 = 第一次使用歌单功能：把曲库里已有的歌（按加入时间）全部并入默认曲库。
 * @returns {{ list: object[], migrated: boolean }}
 */
export function migrate(stored, allTrackIds, now = Date.now()) {
  const valid = Array.isArray(stored) ? stored.filter((p) => p && typeof p.id === 'string' && p.id !== ALL_ID) : [];
  const clean = valid.map((p) => ({ ...p, name: String(p.name || '未命名歌单'), trackIds: dedupe(Array.isArray(p.trackIds) ? p.trackIds : []) }));
  const hasInbox = clean.some((p) => p.id === INBOX_ID);
  const list = hasInbox ? clean : [makeInbox(allTrackIds, now), ...clean];
  return { list: sortPlaylists(list), migrated: !hasInbox };
}

export function sortPlaylists(list) {
  return [...list].sort((a, b) => (a.id === INBOX_ID ? -1 : b.id === INBOX_ID ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
}

export function createPlaylist(list, name, { id = randomId(), now = Date.now() } = {}) {
  const n = normalizeName(name);
  assertUniqueName(list, n);
  const playlist = { id, name: n, coverUrl: null, createdAt: now, updatedAt: now, trackIds: [] };
  return { list: [...list, playlist], playlist };
}

export function renamePlaylist(list, id, name, now = Date.now()) {
  const p = find(list, id);
  if (isSystem(p)) throw new PlaylistError('SYSTEM', `「${p.name}」是系统歌单，不能改名`);
  const n = normalizeName(name);
  assertUniqueName(list, n, id);
  return replace(list, { ...p, name: n, updatedAt: now });
}

export function deletePlaylist(list, id) {
  const p = find(list, id);
  if (isSystem(p)) throw new PlaylistError('SYSTEM', `「${p.name}」是系统歌单，不能删除`);
  return list.filter((x) => x.id !== id);
}

/** 把若干首歌加入若干个歌单（已在里面的不重复，追加在末尾）。返回 { list, changed: 被修改的歌单 } */
export function addTracks(list, playlistIds, trackIds, now = Date.now()) {
  const add = dedupe(trackIds);
  const targets = new Set(playlistIds.filter((id) => id !== ALL_ID));
  const changed = [];
  const next = list.map((p) => {
    if (!targets.has(p.id)) return p;
    const have = new Set(p.trackIds);
    const extra = add.filter((t) => !have.has(t));
    if (!extra.length) return p;
    const np = { ...p, trackIds: [...p.trackIds, ...extra], updatedAt: now };
    changed.push(np);
    return np;
  });
  for (const id of targets) if (!list.some((p) => p.id === id)) throw new PlaylistError('NOT_FOUND', '歌单不存在（可能已被删除）');
  return { list: next, changed };
}

/** 从某个歌单移除（只解绑，音频还在曲库里） */
export function removeTracks(list, playlistId, trackIds, now = Date.now()) {
  const p = find(list, playlistId);
  const drop = new Set(trackIds);
  const kept = p.trackIds.filter((t) => !drop.has(t));
  if (kept.length === p.trackIds.length) return { list, changed: [] };
  const np = { ...p, trackIds: kept, updatedAt: now };
  return { list: replace(list, np), changed: [np] };
}

/**
 * 曲库里已经不存在的歌，从所有歌单里摘掉。
 * pendingOf(trackId) 能给出云端曲目信息时（已登录账号），改为"未下载"留在歌单里：
 * 只是这台设备删了文件腾空间，歌单本身不变，其他设备也不受影响。
 */
export function prune(list, existingTrackIds, now = Date.now(), pendingOf = () => null) {
  const ok = existingTrackIds instanceof Set ? existingTrackIds : new Set(existingTrackIds);
  const changed = [];
  const next = list.map((p) => {
    const kept = p.trackIds.filter((t) => ok.has(t));
    if (kept.length === p.trackIds.length) return p;
    const pending = [...(p.pending || [])];
    for (const t of p.trackIds) {
      if (ok.has(t)) continue;
      const ct = pendingOf(t);
      if (ct?.id && !pending.some((x) => x.id === ct.id)) pending.push(ct);
    }
    const np = { ...p, trackIds: kept, ...(pending.length && { pending }), updatedAt: now };
    changed.push(np);
    return np;
  });
  return { list: next, changed };
}

/** 这首歌在哪些歌单里（用于"添加到歌单"时预先勾选） */
export const playlistsOf = (list, trackId) => list.filter((p) => p.trackIds.includes(trackId)).map((p) => p.id);

/**
 * 歌单 → 播放队列的曲目范围（会话里的条目 id，按歌单顺序）。
 * library 条目：{ id, localId }；歌单存的是 localId（= tracks.id）。playlist 为 null / ALL 时就是整个曲库。
 */
export function resolveScope(playlist, library) {
  if (!playlist || playlist.id === ALL_ID) return library.map((x) => x.id);
  const byLocal = new Map(library.filter((x) => x.localId).map((x) => [x.localId, x.id]));
  return playlist.trackIds.map((t) => byLocal.get(t)).filter(Boolean);
}

/** 歌单里有、但还没加载进当前会话曲库的 tracks.id（需要先从本机读出元数据） */
export function missingFromLibrary(playlist, library) {
  if (!playlist || playlist.id === ALL_ID) return [];
  const have = new Set(library.map((x) => x.localId).filter(Boolean));
  return playlist.trackIds.filter((t) => !have.has(t));
}

function find(list, id) {
  const p = list.find((x) => x.id === id);
  if (!p) throw new PlaylistError('NOT_FOUND', '歌单不存在（可能已被删除）');
  return p;
}
const replace = (list, p) => list.map((x) => (x.id === p.id ? p : x));
function randomId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return `pl-${c.randomUUID()}`;
  return `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ───────────────────────────── store：内存状态 + 持久化（backend 注入，测试时用内存实现）

/**
 * backend: { listPlaylists(): Promise<object[]>, putPlaylist(p), deletePlaylist(id) }（libraryStorage.js 提供）
 * 所有写操作串行执行；先更新内存并通知订阅者（界面立即响应），再写盘，写盘失败时回滚并抛出。
 */
export class PlaylistStore {
  list = [];
  ready = false;
  #subs = new Set();
  #chain = Promise.resolve();

  constructor(backend, { now = () => Date.now() } = {}) {
    this.backend = backend;
    this.now = now;
  }

  subscribe(fn) {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  /** source: 'local'（本机操作）| 'remote'（云端同步写入，不需要再触发同步） */
  #emit(source = 'local') {
    for (const fn of this.#subs) fn(this.list, source);
  }

  get(id) {
    return this.list.find((p) => p.id === id) || null;
  }

  /** 启动时调用一次：allTrackIds 为本机曲库现有歌曲（按加入时间），用于首次迁移和清理失效引用 */
  load(allTrackIds) {
    return this.#serial(async () => {
      const stored = await this.backend.listPlaylists();
      const { list, migrated } = migrate(stored, allTrackIds, this.now());
      const pruned = prune(list, new Set(allTrackIds), this.now());
      this.list = pruned.list;
      this.ready = true;
      this.#emit();
      const writes = migrated ? [this.get(INBOX_ID), ...pruned.changed.filter((p) => p.id !== INBOX_ID)] : pruned.changed;
      for (const p of writes) await this.backend.putPlaylist(p);
      return { migrated, count: this.list.length };
    });
  }

  create(name) {
    return this.#mutate((list) => {
      const { list: next, playlist } = createPlaylist(list, name, { now: this.now() });
      return { next, puts: [playlist], result: playlist };
    });
  }

  rename(id, name) {
    return this.#mutate((list) => {
      const next = renamePlaylist(list, id, name, this.now());
      return { next, puts: [next.find((p) => p.id === id)] };
    });
  }

  remove(id) {
    return this.#mutate((list) => ({ next: deletePlaylist(list, id), deletes: [id] }));
  }

  addTracks(playlistIds, trackIds) {
    return this.#mutate((list) => {
      const { list: next, changed } = addTracks(list, playlistIds, trackIds, this.now());
      return { next, puts: changed, result: changed.length };
    });
  }

  removeTracks(playlistId, trackIds) {
    return this.#mutate((list) => {
      const { list: next, changed } = removeTracks(list, playlistId, trackIds, this.now());
      return { next, puts: changed, result: changed.length };
    });
  }

  prune(existingTrackIds, pendingOf) {
    if (!this.ready) return Promise.resolve(0);
    return this.#mutate((list) => {
      const { list: next, changed } = prune(list, existingTrackIds, this.now(), pendingOf);
      return { next, puts: changed, result: changed.length };
    });
  }

  /** 从歌单里去掉一首还没下载的歌（按云端曲目 id） */
  removePending(playlistId, key) {
    return this.#mutate((list) => {
      const p = find(list, playlistId);
      const pending = (p.pending || []).filter((x) => x.id !== key);
      if (pending.length === (p.pending || []).length) return { next: list };
      const np = { ...p, pending, updatedAt: this.now() };
      return { next: replace(list, np), puts: [np] };
    });
  }

  /** 给一首未下载的歌换音源（原链接失效时） */
  replacePending(playlistId, key, patch) {
    return this.#mutate((list) => {
      const p = find(list, playlistId);
      const np = { ...p, pending: (p.pending || []).map((x) => (x.id === key ? { ...x, ...patch } : x)), updatedAt: this.now() };
      return { next: replace(list, np), puts: [np] };
    });
  }

  /**
   * 云端同步结果写入本机：upserts [{ id, name, createdAt, trackIds, pending }]，deletes [id]。
   * 系统歌单（默认曲库）不会被删除，也保持系统标记。
   */
  applyRemote({ upserts = [], deletes = [] }) {
    return this.#mutate((list) => {
      const drop = new Set(deletes.filter((id) => id !== INBOX_ID));
      let next = list.filter((p) => !drop.has(p.id));
      const puts = [];
      for (const u of upserts) {
        const have = next.find((p) => p.id === u.id);
        const np = { ...(have || { coverUrl: null }), id: u.id, name: u.id === INBOX_ID ? INBOX_NAME : String(u.name || '未命名歌单'), createdAt: have?.createdAt || u.createdAt || this.now(), updatedAt: this.now(), trackIds: dedupe(u.trackIds || []), pending: u.pending || [], ...(u.id === INBOX_ID && { system: true }) };
        next = have ? replace(next, np) : [...next, np];
        puts.push(np);
      }
      return { next, puts, deletes: [...drop].filter((id) => list.some((p) => p.id === id)), source: 'remote' };
    });
  }

  #mutate(fn) {
    return this.#serial(async () => {
      const before = this.list;
      const { next, puts = [], deletes = [], result, source } = fn(before);
      if (next === before && !puts.length && !deletes.length) return result;
      this.list = sortPlaylists(next);
      this.#emit(source);
      try {
        for (const p of puts) await this.backend.putPlaylist(p);
        for (const id of deletes) await this.backend.deletePlaylist(id);
      } catch (e) {
        this.list = before;
        this.#emit();
        throw e;
      }
      return result;
    });
  }

  #serial(fn) {
    const run = this.#chain.then(fn);
    this.#chain = run.catch(() => {});
    return run;
  }
}
