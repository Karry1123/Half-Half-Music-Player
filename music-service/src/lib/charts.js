import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const DAY = 86400000;
export const CHARTS = [
  { id: 'apple-us', title: '美国流行榜（Apple Music）', url: 'https://rss.applemarketingtools.com/api/v2/us/music/most-played/50/songs.json', parser: 'apple' },
  { id: 'apple-gb', title: '英国流行榜（Apple Music）', url: 'https://rss.applemarketingtools.com/api/v2/gb/music/most-played/50/songs.json', parser: 'apple' },
  { id: 'billboard', title: 'Billboard Hot 100', url: 'https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main/recent.json', parser: 'billboard' },
];
const clean = value => typeof value === 'string' ? value.trim().slice(0, 300) : '';
const cover = value => /^https:\/\//i.test(value || '') ? value.slice(0, 2000) : '';
export function parseAppleChart(value) {
  if (!Array.isArray(value?.feed?.results)) throw new Error('Apple Music 榜单格式无效');
  return value.feed.results.slice(0, 50).map((row, i) => ({ title: clean(row.name), artist: clean(row.artistName), cover: cover(row.artworkUrl100), rank: i + 1 })).filter(t => t.title && t.artist);
}
export function parseBillboardChart(value) {
  if (!Array.isArray(value?.data)) throw new Error('Billboard 榜单格式无效');
  return value.data.slice(0, 100).map((row, i) => ({ title: clean(row.song), artist: clean(row.artist), cover: cover(row.image || row.cover), rank: Number.isInteger(row.this_week) && row.this_week > 0 ? row.this_week : i + 1 })).filter(t => t.title && t.artist).sort((a, b) => a.rank - b.rank);
}
const FALLBACK = [
  { title: 'Blinding Lights', artist: 'The Weeknd', cover: '', rank: 1 },
  { title: 'As It Was', artist: 'Harry Styles', cover: '', rank: 2 },
  { title: 'Flowers', artist: 'Miley Cyrus', cover: '', rank: 3 },
];

export class ChartsCache {
  constructor({ dataDir, fetcher = globalThis.fetch, now = Date.now } = {}) {
    this.file = path.join(dataDir, 'discover-charts.json');
    this.fetcher = fetcher;
    this.now = now;
    this.cache = {};
  }
  async init() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      for (const def of CHARTS) {
        const item = data[def.id];
        if (Number.isFinite(item?.updatedAt) && Array.isArray(item.tracks) && item.tracks.length && item.tracks.every(t => typeof t.title === 'string' && typeof t.artist === 'string')) this.cache[def.id] = item;
      }
    } catch {}
    void this.refresh();
    // refresh() only fetches charts older than a day, so checking often just retries failures sooner
    this.timer = setInterval(() => { void this.refresh(); }, 30 * 60 * 1000);
    this.timer.unref?.();
    return this;
  }
  stop() { clearInterval(this.timer); }
  chart(id) {
    const def = CHARTS.find(c => c.id === id);
    if (!def) return null;
    const cached = this.cache[id];
    const tracks = cached?.tracks || FALLBACK;
    return { id, title: def.title, cover: tracks.find(t => t.cover)?.cover || '', updatedAt: cached?.updatedAt || 0, stale: !cached || this.now() - cached.updatedAt >= DAY, tracks };
  }
  list() { return { charts: CHARTS.map(def => { const { tracks, ...chart } = this.chart(def.id); return { ...chart, count: tracks.length }; }) }; }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await Promise.all(CHARTS.map(async def => {
        if (this.cache[def.id] && this.now() - this.cache[def.id].updatedAt < DAY) return;
        try {
          const response = await this.fetcher(def.url, { signal: AbortSignal.timeout(20000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          const tracks = def.parser === 'apple' ? parseAppleChart(data) : parseBillboardChart(data);
          if (!tracks.length) throw new Error('榜单为空');
          this.cache[def.id] = { tracks, updatedAt: this.now() };
        } catch (e) { console.warn(`[discover] ${def.id}: ${e.message}`); }
      }));
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(this.file + '.tmp', JSON.stringify(this.cache), 'utf8');
        await rename(this.file + '.tmp', this.file);
      } catch (e) { console.warn('[discover] 榜单缓存写入失败:', e.message); }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}

export function mountCharts(app, guard, charts) {
  app.get('/discover/charts', guard, (_req, res) => res.json(charts.list()));
  app.get('/discover/charts/:id', guard, (req, res) => {
    const chart = charts.chart(req.params.id);
    return chart ? res.json(chart) : res.status(404).json({ error: '榜单不存在' });
  });
}
