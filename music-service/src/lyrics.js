// LRCLIB v1 client; dependency injection keeps network and cache tests offline.
const normal = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const clean = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 200000) : null;
export function shapeLyrics(record) {
  if (!record || record.instrumental) return { synced: null, plain: null };
  const synced = clean(record.syncedLyrics), plain = clean(record.plainLyrics);
  return synced || plain ? { synced, plain, source: 'lrclib' } : { synced: null, plain: null };
}
export function lyricsKey({ title = '', artist = '', duration = 0, q = '' }) {
  return JSON.stringify([normal(q) ? `q:${normal(q)}` : normal(title), normal(artist), Math.round(Number(duration) || 0)]);
}
export function createLyricsClient({ fetchImpl = globalThis.fetch, now = Date.now, capacity = 200, ttl = 86400000 } = {}) {
  const cache = new Map(), pending = new Map();
  let retryAt = 0;
  async function lookup(input) {
    if (now() < retryAt) throw new Error('歌词服务繁忙，请稍后重试');
    const title = String(input.title || '').trim(), artist = String(input.artist || '').trim();
    const duration = Number(input.duration) || 0;
    const signal = AbortSignal.timeout(8000);
    const request = async (endpoint, params) => {
      const r = await fetchImpl(`https://lrclib.net/api/${endpoint}?${params}`, { signal, headers: {
        'User-Agent': 'HalfAndHalfMusicPlayer/0.12 (https://github.com/Karry1123/Half-Half-Music-Player)', Accept: 'application/json',
      } });
      if (r.status === 404) return null;
      if (!r.ok) {
        if (r.status === 429 || r.status === 503) {
          const retry = r.headers?.get('retry-after');
          const wait = Number(retry) || Math.max(0, (Date.parse(retry) - now()) / 1000) || 30;
          retryAt = now() + wait * 1000;
        }
        throw new Error('歌词服务暂时不可用，请稍后重试');
      }
      return r.json();
    };
    if (title && artist && !input.q) {
      const params = new URLSearchParams({ track_name: title, artist_name: artist });
      if (input.album) params.set('album_name', String(input.album));
      if (duration >= 1 && duration <= 3600) params.set('duration', String(Math.round(duration)));
      const record = await request('get', params);
      const shaped = shapeLyrics(record);
      if (shaped.synced || shaped.plain || record?.instrumental) return shaped;
    }
    const q = String(input.q || [title, artist].filter(Boolean).join(' ')).trim();
    if (!q) return { synced: null, plain: null };
    const records = await request('search', new URLSearchParams({ q }));
    const candidates = (Array.isArray(records) ? records : []).filter(record => {
      if (!shapeLyrics(record).synced && !shapeLyrics(record).plain) return false;
      if (input.q) return true;
      if (title && normal(record.trackName || record.name) !== normal(title)) return false;
      if (artist && normal(record.artistName) !== normal(artist)) return false;
      return !duration || !Number(record.duration) || Math.abs(record.duration - duration) <= 15;
    });
    if (duration) candidates.sort((a, b) => Math.abs((a.duration || duration) - duration) - Math.abs((b.duration || duration) - duration));
    return shapeLyrics(candidates[0]);
  }
  return async function getLyrics(input = {}) {
    const key = lyricsKey(input), hit = cache.get(key);
    if (hit && now() - hit.at < ttl) { cache.delete(key); cache.set(key, hit); return hit.value; }
    cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    const task = lookup(input).then(value => {
      cache.set(key, { value, at: now() });
      while (cache.size > capacity) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}
export const getLyrics = createLyricsClient();
