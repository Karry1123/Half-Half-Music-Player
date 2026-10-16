// One attempt per track per page load, two workers, and a circuit breaker on
// network/API errors. A large offline library must not become a retry queue.
// Tracks without a stored cover URL need a backend resolve (a yt-dlp run), so
// those are capped per launch to keep the small server from being flooded.
export function createCoverBackfill({ available, resolve, save, onCover, maxResolves = 12 }) {
  const attempted = new Set();
  let running = false, unavailable = false, resolves = 0;
  return async tracks => {
    if (running || unavailable || !available()) return;
    running = true;
    const pending = tracks.filter(t => !t.hasCover && !attempted.has(t.id) && (t.coverUrl || t.pageUrl || t.sourceId));
    try {
      await Promise.all(Array.from({ length: 2 }, async () => {
        while (pending.length && !unavailable && available()) {
          const t = pending.shift();
          attempted.add(t.id);
          try {
            if (!t.coverUrl && resolves >= maxResolves) continue;
            if (!t.coverUrl) resolves += 1;
            const url = t.coverUrl || (await resolve(sourcePage(t)))?.cover;
            if (!url) continue;
            const updated = await save(t.id, url);
            if (updated) await onCover(updated);
          } catch { unavailable = true; }
        }
      }));
    } finally { running = false; }
  };
}

export function sourcePage(track) {
  if (track.pageUrl) return track.pageUrl;
  const id = String(track.sourceId || '');
  const match = /^(youtube|ytmusic|bilibili):(.+)$/.exec(id);
  const source = match?.[1] || track.source, key = match?.[2] || id;
  if (source === 'youtube' || source === 'ytmusic') return `https://${source === 'ytmusic' ? 'music' : 'www'}.youtube.com/watch?v=${encodeURIComponent(key)}`;
  if (source === 'bilibili') return `https://www.bilibili.com/video/${encodeURIComponent(key)}`;
  return id;
}
