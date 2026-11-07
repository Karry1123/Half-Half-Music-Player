// DOM-free LRC parsing, query metadata and a bounded per-track local cache.
export function parseLrc(text) {
  if (typeof text !== 'string') return [];
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):([0-5]\d)(?:\.(\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const content = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const stamp of stamps) {
      const time = Number(stamp[1]) * 60 + Number(stamp[2]) + Number(`0.${stamp[3] || '0'}`);
      if (Number.isFinite(time)) lines.push({ time, text: content });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}
export function currentLineIndex(lines, position) {
  if (!Number.isFinite(position)) return -1;
  let low = 0, high = lines.length - 1, index = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (lines[mid].time <= position) { index = mid; low = mid + 1; } else high = mid - 1;
  }
  return index;
}
export function lyricsQuery(track = {}, duration = track.duration) {
  const strip = value => String(value || '').replace(/\s*[（(\[]\s*(?:演示|official\s+(?:music\s+)?video|official\s+audio|music\s+video|mv)\s*[）)\]]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  const title = strip(track.title), artist = strip(track.artist);
  if (!title || /^(未命名|未知歌曲|unknown|untitled)$/i.test(title)) return null;
  if ((track.source === 'local' || (!track.source && !track.sourceId)) && (!artist || /^(本地文件|未知歌手|未知艺术家|unknown(?: artist)?)$/i.test(artist))) return null;
  return { title, artist, album: String(track.album || '').trim(), duration: Number.isFinite(duration) && duration > 0 ? duration : 0 };
}
const shape = data => ({ synced: typeof data?.synced === 'string' ? data.synced : null, plain: typeof data?.plain === 'string' ? data.plain : null, ...(data?.source === 'lrclib' && { source: 'lrclib' }) });
export function createLyricsCache({ storage, now = Date.now, maxChars = 500000, maxEntries = 100, ttl = 86400000, key = 'hh.lyrics.v1' } = {}) {
  const listeners = new Set();
  const changed = id => listeners.forEach(listener => listener(id));
  const backend = () => storage === undefined ? globalThis.localStorage : storage;
  const clampOffset = value => Number.isFinite(Number(value)) ? Math.max(-30, Math.min(30, Number(value))) : 0;
  const fresh = entry => entry?.data && typeof entry.data === 'object' && now() - entry.at < ttl;
  const read = () => {
    try {
      const raw = backend()?.getItem(key);
      if (!raw || raw.length > maxChars) return [];
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data.filter(entry => typeof entry?.id === 'string' && (fresh(entry) || clampOffset(entry.offset) !== 0)) : [];
    } catch { return []; }
  };
  const write = entries => {
    while (entries.length && (entries.length > maxEntries || JSON.stringify(entries).length > maxChars)) entries.shift();
    try { backend()?.setItem(key, JSON.stringify(entries)); } catch {}
  };
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get(id) {
      const entries = read(), index = entries.findIndex(entry => entry.id === id);
      if (index < 0 || !fresh(entries[index])) return null;
      const [entry] = entries.splice(index, 1); entries.push(entry); write(entries);
      return shape(entry.data);
    },
    set(id, data) {
      if (!id) return;
      const entries = read(), offset = clampOffset(entries.find(entry => entry.id === id)?.offset);
      write([...entries.filter(entry => entry.id !== id), { id, at: now(), data: shape(data), offset }]);
      changed(id);
    },
    // Refresh lyrics without losing the listener's timing correction.
    remove(id) {
      write(read().flatMap(entry => entry.id !== id ? [entry] : clampOffset(entry.offset) ? [{ ...entry, data: null }] : []));
      changed(id);
    },
    getOffset(id) { return clampOffset(read().find(entry => entry.id === id)?.offset); },
    setOffset(id, value) {
      const offset = clampOffset(value);
      if (!id) return offset;
      const entries = read(), previous = entries.find(entry => entry.id === id);
      write([...entries.filter(entry => entry.id !== id), { ...(previous || { id, at: 0, data: null }), offset }]);
      changed(id);
      return offset;
    },
  };
}
