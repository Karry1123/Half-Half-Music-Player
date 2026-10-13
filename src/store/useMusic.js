// 搜索 / 下载 / 曲库状态（Zustand）。仅 Host 使用：music-service 运行在 Host 本机。
import { create } from 'zustand';
import { musicApi } from '../engine/musicApi.js';

let unsubscribeEvents = null;

export const useMusic = create((set, get) => ({
  available: null, // null 检测中 / true / false
  health: null, // { ytdlp, ffmpeg, providers: [{ name, label }] }
  drawerOpen: false,

  query: '',
  sources: [], // 选中的音源，空 = 全部
  versions: 'original', // 'original' | 'all'
  format: 'm4a',
  searching: false,
  result: null, // /api/search 的响应
  error: null,

  jobs: {}, // jobId → job（SSE 实时更新）
  library: [], // downloads/library.json

  async init() {
    try {
      const health = await musicApi.health();
      set({ available: true, health, format: health.ffmpeg ? 'mp3' : 'm4a' });
    } catch {
      set({ available: false });
      return;
    }
    get().refreshLibrary();
    unsubscribeEvents?.();
    unsubscribeEvents = musicApi.subscribe({
      onSnapshot: (list) => set({ jobs: Object.fromEntries(list.map((j) => [j.id, j])) }),
      onJob: (job) => {
        const prev = get().jobs[job.id];
        set({ jobs: { ...get().jobs, [job.id]: job } });
        if (job.status === 'done' && prev?.status !== 'done') get().refreshLibrary();
      },
    });
  },

  setDrawer: (open) => set({ drawerOpen: open }),
  setQuery: (query) => set({ query }),
  setFormat: (format) => set({ format }),

  toggleSource(name) {
    const all = get().health?.providers.map((p) => p.name) ?? [];
    const current = get().sources.length ? get().sources : all;
    const next = current.includes(name) ? current.filter((s) => s !== name) : [...current, name];
    set({ sources: next.length === all.length ? [] : next });
    if (get().result) get().search();
  },

  setVersions(versions) {
    set({ versions });
    if (get().result) get().search(); // 服务端有缓存，切换不会重新请求各平台
  },

  async search() {
    const q = get().query.trim();
    if (!q) return;
    set({ searching: true, error: null });
    try {
      const result = await musicApi.search({ q, sources: get().sources, versions: get().versions });
      if (get().query.trim() === q) set({ result });
    } catch (e) {
      set({ error: e.message });
    } finally {
      set({ searching: false });
    }
  },

  async download(trackId) {
    try {
      const r = await musicApi.download(trackId, get().format);
      if (r.job) set({ jobs: { ...get().jobs, [r.job.id]: r.job } });
      if (r.status === 'exists') get().refreshLibrary();
      return r;
    } catch (e) {
      set({ error: e.message });
      return null;
    }
  },

  async refreshLibrary() {
    try {
      set({ library: await musicApi.library() });
    } catch {}
  },
}));

/** 某条搜索结果当前的下载任务（按 trackId 取最新一条） */
export function jobForTrack(jobs, trackId) {
  let found = null;
  for (const j of Object.values(jobs)) if (j.trackId === trackId && (!found || j.createdAt > found.createdAt)) found = j;
  return found;
}
