// Two workers, a bounded resolve batch, and a recovering circuit breaker.
// Failed fetches stay eligible; a successful durable blob ends the retries.
export function createCoverBackfill({ available, resolve, save, onCover, metadata = () => [], maxResolves = 12,
  retryBaseMs = 15000, retryMaxMs = 300000, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const known = new Map(), complete = new Set(), failures = new Map();
  let running = false, timer = null, cooldown = 0, outage = 0;
  const delay = attempt => Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempt - 1, 8));
  const eligible = t => !t.hasCover && !complete.has(t.id) && (t.coverUrl || t.cover || t.pageUrl || t.sourceId || metadata(t).length);
  const queueNext = () => {
    if (timer) cancel(timer);
    const pending = [...known.values()].filter(eligible);
    if (!pending.length) { timer = null; return; }
    const next = Math.min(...pending.map(t => failures.get(t.id)?.at || now()));
    timer = schedule(() => { timer = null; void run(); }, Math.max(retryBaseMs, cooldown - now(), next - now()));
    timer?.unref?.();
  };
  async function run(tracks) {
    if (tracks) { known.clear(); for (const t of tracks) known.set(t.id, t); }
    if (running) return;
    if (!available() || cooldown > now()) { queueNext(); return; }
    running = true;
    let resolves = 0, networkFailed = false;
    const pending = [...known.values()].filter(t => eligible(t) && (failures.get(t.id)?.at || 0) <= now());
    try {
      await Promise.all(Array.from({ length: 2 }, async () => {
        while (pending.length && !networkFailed && available()) {
          const t = pending.shift();
          try {
            const candidates = [t.coverUrl, t.cover, ...metadata(t)].filter(x => typeof x === 'string' && x);
            let updated = null;
            for (const url of new Set(candidates)) {
              updated = await save(t.id, url);
              if (updated?.hasCover) break;
            }
            // A stale URL must not prevent resolving fresh search/source metadata.
            if (!updated?.hasCover && (t.pageUrl || t.sourceId)) {
              if (resolves >= maxResolves) continue;
              resolves++;
              const result = await resolve(sourcePage(t));
              if (result?.cover || result?.coverUrl) updated = await save(t.id, result.cover || result.coverUrl);
            }
            if (updated?.hasCover) {
              complete.add(t.id); failures.delete(t.id); outage = 0;
              await onCover(updated);
            } else {
              const count = (failures.get(t.id)?.count || 0) + 1;
              failures.set(t.id, { count, at: now() + delay(count) });
            }
          } catch {
            const count = (failures.get(t.id)?.count || 0) + 1;
            failures.set(t.id, { count, at: now() + delay(count) });
            networkFailed = true;
            cooldown = now() + delay(++outage);
          }
        }
      }));
    } finally { running = false; queueNext(); }
  }
  run.dispose = () => { if (timer) cancel(timer); timer = null; known.clear(); };
  return run;
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
