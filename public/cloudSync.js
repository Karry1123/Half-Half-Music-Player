// cloudSync.js — 账号下的歌单自动双向同步（纯逻辑 + 一个小的同步调度器；不依赖 DOM，Node 下可单测）
//
// 云端只存元数据：[{ id, name, createdAt, updatedAt, tracks: [cloudTrack] } | { id, deleted: true, updatedAt }]
// 本机歌单：{ id, name, trackIds: [本机 tracks.id], pending: [cloudTrack] }
//   trackIds = 这台设备上已有音频的歌；pending = 歌单里有、但这台设备还没下载的歌（界面显示"未下载"）。
//
// 三方合并：每台设备记住"上次同步后的样子"（base）。和 base 比，本机删掉的歌 / 歌单才算删除，
// 本机新加的才算新增；同样的规则作用于云端。于是两台设备各自加歌、各自删歌都不会互相覆盖，
// 第一次同步（没有 base）时两边取并集。

const TOMBSTONE_TTL = 180 * 86400000; // 删除标记保留半年，足够让久未打开的设备也收到

/** 跨设备识别同一首歌：优先音源 ID（同一个 B 站 / YouTube 视频），其次音频指纹 */
export const trackKey = (t) => (t?.sourceId ? t.sourceId : t?.hash ? `hash:${t.hash}` : null);

export function toCloudTrack(t) {
  return { id: trackKey(t), title: t.title || '', artist: t.artist || '', cover: [t.coverUrl, t.cover].find(value => typeof value === 'string' && /^https:\/\//i.test(value)) || '', sourceId: t.sourceId || '', pageUrl: /^https:\/\//.test(t.pageUrl || '') ? t.pageUrl : '', hash: t.hash || '', duration: Number(t.duration) || 0 };
}

/** 本机曲库索引：cloudTrack → 本机 tracks.id（按音源 ID 或指纹） */
export function indexTracks(tracks) {
  const byKey = new Map();
  for (const t of tracks) {
    if (t.sourceId) byKey.set(t.sourceId, t.id);
    if (t.hash) byKey.set(`hash:${t.hash}`, t.id);
  }
  return {
    localIdOf: (ct) => byKey.get(ct.id) || (ct.sourceId && byKey.get(ct.sourceId)) || (ct.hash && byKey.get(`hash:${ct.hash}`)) || null,
  };
}

/** 本机歌单 → 同步视图 { id, name, createdAt, keys, tracks: Map<key, cloudTrack> }（已下载的在前，未下载的在后） */
export function localView(p, tracksById) {
  const tracks = new Map();
  const keys = [];
  const push = (ct) => {
    if (!ct?.id || tracks.has(ct.id)) return;
    tracks.set(ct.id, ct);
    keys.push(ct.id);
  };
  for (const id of p.trackIds || []) {
    const t = tracksById.get(id);
    if (t && trackKey(t)) push(toCloudTrack(t));
  }
  for (const ct of p.pending || []) push(ct);
  return { id: p.id, name: p.name, isPublic: p.isPublic === true, coverUrl: p.coverUrl || null, createdAt: p.createdAt || 0, keys, tracks };
}

/** 三方合并曲目列表：以云端顺序为准，去掉本机删掉的，追加本机新加的 */
export function mergeKeys(base, local, cloud) {
  const b = new Set(base), l = new Set(local);
  const removed = new Set(base.filter((k) => !l.has(k)));
  const added = local.filter((k) => !b.has(k));
  const out = cloud.filter((k) => !removed.has(k));
  const seen = new Set(out);
  for (const k of added) if (!seen.has(k)) (seen.add(k), out.push(k));
  return out;
}

const sameKeys = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * @param {object} o
 * @param {Array}  o.local    localView() 结果
 * @param {Array}  o.cloud    云端歌单（含删除标记）
 * @param {object} o.base     { [id]: { name, keys } } 上次同步结果（这台设备）
 * @param {string} [o.legacyPrefix] 旧版「缓存到本机」生成的歌单 id 前缀（cloud-<用户>-），并回对应的云端歌单
 * @param {number} [o.now]
 * @returns {{ cloud: Array, cloudChanged: boolean, upserts: Array, deletes: string[], base: object }}
 *   upserts: [{ id, name, createdAt, keys, tracks: Map }] 需要写入本机的歌单；deletes: 需要从本机删除的歌单 id
 */
export function mergePlaylists({ local, cloud, base = {}, legacyPrefix = '', now = Date.now() }) {
  const deletes = [];
  const cloudById = new Map(cloud.filter((p) => p?.id).map((p) => [p.id, p]));
  const alive = (id) => cloudById.has(id) && !cloudById.get(id).deleted;

  // 同一个歌单在两台设备上各建了一次（第一次同步、没有 base）：按名字并成一个，用云端的 id
  const claimed = new Set();
  const views = local.map((v) => {
    let target = null;
    if (legacyPrefix && v.id.startsWith(legacyPrefix) && alive(v.id.slice(legacyPrefix.length))) target = v.id.slice(legacyPrefix.length);
    else if (!base[v.id] && !cloudById.has(v.id)) {
      const twin = cloud.find((c) => !c.deleted && !base[c.id] && !claimed.has(c.id) && !local.some((x) => x.id === c.id) && c.name === v.name);
      if (twin) target = twin.id;
    }
    if (!target) return v;
    claimed.add(target);
    deletes.push(v.id);
    return { ...v, id: target, renamedFrom: v.id };
  });
  // 两个本机歌单并到同一个云端 id（旧版副本 + 同名歌单）：合成一个
  const localById = new Map();
  for (const v of views) {
    const have = localById.get(v.id);
    if (!have) { localById.set(v.id, v); continue; }
    const tracks = new Map([...have.tracks, ...v.tracks]);
    localById.set(v.id, { ...have, keys: mergeKeys([], v.keys, have.keys), tracks });
  }

  const ids = new Set([...localById.keys(), ...cloudById.keys(), ...Object.keys(base)]);
  const nextCloud = [], upserts = [], nextBase = {};
  for (const id of ids) {
    const L = localById.get(id), C = cloudById.get(id), B = base[id];
    const tracksOf = (...sources) => {
      const m = new Map();
      for (const s of sources) if (s?.tracks) for (const t of s.tracks instanceof Map ? s.tracks.values() : s.tracks) if (t?.id && !m.has(t.id)) m.set(t.id, t);
      return m;
    };
    const unchangedLocally = L && B && L.name === B.name && (L.isPublic === true) === (B.isPublic === true) && (L.coverUrl || null) === (B.coverUrl || null) && sameKeys(L.keys, B.keys) && !L.renamedFrom;
    const cloudKeys = C && !C.deleted ? C.tracks.map((t) => t.id) : null;
    const unchangedInCloud = C && !C.deleted && B && C.name === B.name && (C.isPublic === true) === (B.isPublic === true) && (C.coverUrl || null) === (B.coverUrl || null) && sameKeys(cloudKeys, B.keys);

    let merged = null; // { name, keys, tracks, createdAt }
    let tombstone = null;
    if (L && C && !C.deleted) {
      const name = B && L.name !== B.name ? L.name : C.name;
      merged = { name, isPublic: B && (L.isPublic === true) !== (B.isPublic === true) ? L.isPublic === true : C.isPublic === true, coverUrl: B && (L.coverUrl || null) !== (B.coverUrl || null) ? L.coverUrl || null : C.coverUrl || null, keys: mergeKeys(B?.keys || [], L.keys, cloudKeys), tracks: tracksOf(C, L), createdAt: C.createdAt || L.createdAt };
    } else if (L && C?.deleted) {
      if (unchangedLocally) { deletes.push(id); tombstone = C; } // 另一台设备删了、这台没再改过 → 跟着删
      else merged = { name: L.name, isPublic: L.isPublic === true, coverUrl: L.coverUrl || null, keys: L.keys, tracks: L.tracks, createdAt: L.createdAt }; // 本机还在改：保留并重新上传
    } else if (L) {
      merged = { name: L.name, isPublic: L.isPublic === true, coverUrl: L.coverUrl || null, keys: L.keys, tracks: L.tracks, createdAt: L.createdAt };
    } else if (C && !C.deleted) {
      if (B && unchangedInCloud) tombstone = { id, deleted: true, updatedAt: now }; // 本机删了、云端没人动过 → 删除
      else merged = { name: C.name, isPublic: C.isPublic === true, coverUrl: C.coverUrl || null, keys: cloudKeys, tracks: tracksOf(C), createdAt: C.createdAt };
    } else if (C?.deleted) {
      tombstone = C;
    }

    if (tombstone) {
      if (now - (tombstone.updatedAt || now) < TOMBSTONE_TTL) nextCloud.push({ id, deleted: true, updatedAt: tombstone.updatedAt || now });
      continue;
    }
    if (!merged) continue;
    const tracks = merged.keys.map((k) => merged.tracks.get(k)).filter(Boolean);
    const keys = tracks.map((t) => t.id);
    const changedInCloud = !C || C.deleted || C.name !== merged.name || (C.isPublic === true) !== merged.isPublic || (C.coverUrl || null) !== merged.coverUrl || !sameKeys(cloudKeys, keys);
    nextCloud.push({ id, name: merged.name, isPublic: merged.isPublic, coverUrl: merged.coverUrl, createdAt: merged.createdAt || now, updatedAt: changedInCloud ? now : C.updatedAt || now, tracks });
    if (!L || L.name !== merged.name || (L.isPublic === true) !== merged.isPublic || (L.coverUrl || null) !== merged.coverUrl || !sameKeys(L.keys, keys) || L.renamedFrom) upserts.push({ id, name: merged.name, isPublic: merged.isPublic, coverUrl: merged.coverUrl, createdAt: merged.createdAt || now, keys, tracks: new Map(tracks.map((t) => [t.id, t])) });
    nextBase[id] = { name: merged.name, isPublic: merged.isPublic, coverUrl: merged.coverUrl, keys };
  }
  const order = new Map(cloud.map((p, i) => [p.id, i]));
  nextCloud.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  const cloudChanged = JSON.stringify(nextCloud) !== JSON.stringify(cloud);
  return { cloud: nextCloud, cloudChanged, upserts, deletes: [...new Set(deletes)], base: nextBase };
}

/** 同步结果里的一个歌单 → 本机记录的 trackIds / pending */
export function splitForDevice(keys, tracks, index) {
  const trackIds = [], pending = [];
  for (const k of keys) {
    const ct = tracks.get(k);
    if (!ct) continue;
    const local = index.localIdOf(ct);
    local ? trackIds.push(local) : pending.push(ct);
  }
  return { trackIds: [...new Set(trackIds)], pending };
}

/**
 * 同步调度：登录且激活后自动运行；本机歌单变化后 2 秒、回到前台、每分钟各同步一次。
 * deps: { client: AccountClient, store: PlaylistStore, listTracks(), loadBase(userId), saveBase(userId, base), onStatus(s) }
 */
export class CloudSync {
  #timer = null;
  #running = null;
  #again = false;
  status = { state: 'idle', at: 0, error: '' };

  constructor(deps) {
    this.deps = deps;
  }

  get enabled() {
    const c = this.deps.client;
    return !!(c.required && c.user?.isActivated);
  }

  /** 本机歌单变了：稍等片刻合并多次修改再同步 */
  schedule(delay = 2000) {
    if (!this.enabled) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.sync().catch(() => {}), delay);
  }

  sync() {
    if (!this.enabled) return Promise.resolve(null);
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        let result;
        do {
          this.#again = false;
          result = await this.#once();
        } while (this.#again);
        return result;
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  #set(status) {
    this.status = { ...this.status, ...status };
    this.deps.onStatus?.(this.status);
  }

  async #once() {
    const { client, store, listTracks, loadBase, saveBase } = this.deps;
    const userId = client.user.id;
    this.#set({ state: 'syncing', error: '' });
    try {
      for (let attempt = 0; ; attempt++) {
        const tracks = await listTracks();
        const tracksById = new Map(tracks.map((t) => [t.id, t]));
        const cloud = await client.pull();
        const base = (await loadBase(userId)) || {};
        const local = store.list.map((p) => localView(p, tracksById));
        const result = mergePlaylists({ local, cloud, base, legacyPrefix: `cloud-${userId}-` });
        if (result.cloudChanged) {
          try {
            await client.push(result.cloud);
          } catch (e) {
            if (e.status === 409 && attempt < 3) continue; // 另一台设备刚写过：重新拉取再合并
            throw e;
          }
        }
        const index = indexTracks(tracks);
        const upserts = result.upserts.map((u) => ({ id: u.id, name: u.name, isPublic: u.isPublic, coverUrl: u.coverUrl, createdAt: u.createdAt, ...splitForDevice(u.keys, u.tracks, index) }));
        // 歌单内容没变、但这台设备刚下载了其中"未下载"的歌：把它从 pending 挪进 trackIds
        const touched = new Set([...upserts.map((u) => u.id), ...result.deletes]);
        for (const p of store.list) {
          if (touched.has(p.id)) continue;
          const v = localView(p, tracksById);
          const split = splitForDevice(v.keys, v.tracks, index);
          if (!sameKeys(split.trackIds, p.trackIds) || split.pending.length !== (p.pending || []).length) upserts.push({ id: p.id, name: p.name, isPublic: p.isPublic === true, coverUrl: p.coverUrl || null, createdAt: p.createdAt, ...split });
        }
        if (upserts.length || result.deletes.length) await store.applyRemote({ upserts, deletes: result.deletes });
        await saveBase(userId, result.base);
        this.#set({ state: 'ok', at: Date.now() });
        return result;
      }
    } catch (e) {
      this.#set({ state: 'error', error: e.message });
      throw e;
    }
  }
}
