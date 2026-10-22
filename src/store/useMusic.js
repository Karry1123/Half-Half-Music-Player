// 搜索 / 下载 / 曲库状态（Zustand）。仅 Host 使用：music-service 运行在 Host 本机。
import { create } from 'zustand';
import { musicApi } from '../engine/musicApi.js';
import { toast } from './useToast.js';

let unsubscribeEvents = null;
export const ACTIVE_DOWNLOADS = ['queued', 'downloading', 'processing'];
const QUEUE_KEY = 'hh.downloadQueue';
function loadQueue() {
  try {
    const saved = JSON.parse(localStorage.getItem(QUEUE_KEY));
    const jobs = Object.fromEntries(Object.values(saved?.jobs || {}).filter((j) => j?.id && j.trackId).map((j) => [j.id,
      ACTIVE_DOWNLOADS.includes(j.status) ? { ...j, recovered: true, status: 'error', error: '下载已中断，请重新下载' } : j,
    ]));
    return { jobs, dismissedJobs: saved?.dismissedJobs || [] };
  } catch { return { jobs: {}, dismissedJobs: [] }; }
}

function jobNotice(job) {
  if (job.status === 'error') toast(`《${job.title}》下载失败，请到下载队列重试`, { icon: 'close', kind: 'error', key: 'download' });
  if (job.status === 'done') toast(`《${job.title}》下载完成`, { icon: 'check', kind: 'success', key: 'download' });
}

export const useMusic = create((set, get) => ({
  available: null, // null 检测中 / true / false
  health: null, // { ytdlp, ffmpeg, providers: [{ name, label }] }
  drawerOpen: false,
  queueOpen: false,

  query: '',
  sources: [], // 选中的音源，空 = 全部
  versions: 'original', // 'original' | 'all'
  format: 'm4a',
  searching: false,
  result: null, // /api/search 的响应
  error: null,

  ...loadQueue(), // Retain metadata and failed requests independently of search results.
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
      onSnapshot: (list) => {
        list.forEach((job) => get().receiveJob(job, ACTIVE_DOWNLOADS.includes(get().jobs[job.id]?.status)));
        const ids = new Set(list.map((j) => j.id));
        const jobs = { ...get().jobs };
        for (const j of Object.values(jobs)) {
          if (!j.id.startsWith('local:') && ACTIVE_DOWNLOADS.includes(j.status) && !ids.has(j.id)) {
            jobs[j.id] = { ...j, status: 'error', error: '服务端任务已中断，请重新下载' };
            jobNotice(jobs[j.id]);
          }
        }
        set({ jobs });
        get().refreshLibrary();
      },
      onJob: (job) => get().receiveJob(job),
    });
  },

  setDrawer: (open) => set({ drawerOpen: open }),
  setQueue: (open) => set({ queueOpen: open }),
  removeJob(id) {
    const jobs = { ...get().jobs };
    delete jobs[id];
    set({ jobs, dismissedJobs: [...new Set([...get().dismissedJobs, id])] });
  },
  clearCompleted() {
    for (const j of Object.values(get().jobs)) if (j.status === 'done') get().removeJob(j.id);
  },
  receiveJob(job, notify = true) {
    if (get().dismissedJobs.includes(job.id)) return;
    const prev = get().jobs[job.id];
    const fallback = prev || Object.values(get().jobs).find((j) => j.trackId === job.trackId && j.format === job.format);
    const result = get().result?.results.find((t) => t.id === job.trackId);
    const merged = { ...fallback, ...job, cover: job.cover || fallback?.cover || result?.cover || null };
    const jobs = { ...get().jobs, [job.id]: merged };
    for (const j of Object.values(jobs)) {
      if (j.id !== job.id && j.recovered && j.id.startsWith('local:') && j.trackId === job.trackId && j.format === job.format) delete jobs[j.id];
    }
    set({ jobs });
    if (prev?.status !== job.status) {
      if (notify) jobNotice(merged);
      if (job.status === 'done') get().refreshLibrary();
    }
  },
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

  async download(trackId, options = {}) {
    const old = options.jobId ? get().jobs[options.jobId] : jobForTrack(get().jobs, trackId);
    const active = Object.values(get().jobs).find((j) => j.trackId === trackId && ACTIVE_DOWNLOADS.includes(j.status));
    if (active) return { job: active };
    const track = get().result?.results.find((t) => t.id === trackId) || old || {};
    const format = options.jobId ? old?.format || get().format : get().format;
    const id = `local:${globalThis.crypto.randomUUID()}`;
    const pending = { id, trackId, title: track.title || trackId, artist: track.artist || '', cover: track.cover || null,
      format, status: 'queued', progress: 0, createdAt: Date.now(), error: null };
    if (old?.status === 'error') get().removeJob(old.id);
    set({ jobs: { ...get().jobs, [id]: pending } });
    toast(`已加入下载队列：《${pending.title}》`, { icon: 'download', key: 'download' });
    try {
      const r = await musicApi.download(trackId, format, { title: pending.title, artist: pending.artist });
      // SSE may have delivered a newer status before this HTTP response arrived.
      if (r.job) {
        const latest = get().jobs[r.job.id];
        if (get().dismissedJobs.includes(id)) get().removeJob(r.job.id);
        else get().receiveJob({ ...pending, ...r.job, ...latest, cover: pending.cover || latest?.cover });
        get().removeJob(id);
      } else if (r.status === 'exists') {
        const done = { ...pending, ...r.entry, id, trackId, status: 'done', file: r.file, progress: 1 };
        if (!get().dismissedJobs.includes(id)) set({ jobs: { ...get().jobs, [id]: done } });
        jobNotice(done);
        get().refreshLibrary();
      } else throw new Error('下载服务未返回任务，请重试');
      return r;
    } catch (e) {
      const failed = { ...pending, status: 'error', error: e.message };
      if (!get().dismissedJobs.includes(id)) set({ jobs: { ...get().jobs, [id]: failed } });
      jobNotice(failed);
      return null;
    }
  },

  async refreshLibrary() {
    try {
      set({ library: await musicApi.library() });
    } catch {}
  },
}));

// Same lightweight localStorage pattern as profile / volume; storage failures do not block downloads.
useMusic.subscribe((s, prev) => {
  if (s.jobs === prev.jobs && s.dismissedJobs === prev.dismissedJobs) return;
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify({ jobs: s.jobs, dismissedJobs: s.dismissedJobs })); } catch {}
});

/** 某条搜索结果当前的下载任务（按 trackId 取最新一条） */
export function jobForTrack(jobs, trackId) {
  let found = null;
  for (const j of Object.values(jobs)) if (j.trackId === trackId && (!found || j.createdAt > found.createdAt)) found = j;
  return found;
}
