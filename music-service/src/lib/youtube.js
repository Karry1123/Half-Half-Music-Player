import { setTimeout as delay } from 'node:timers/promises';
import { norm } from './rank.js';

export const isYoutubeBotError = (text = '') => /sign in to confirm|confirm (?:you(?:['’]re| are) )?not a bot|use --cookies.*authentication/i.test(text);

/** One process-wide lane, including metadata extraction; failures never poison the queue. */
export function createYoutubeRunner({ intervalMs = 1500, backoffMs = 4000, random = Math.random, sleep = delay, now = Date.now, cacheTtlMs = 300000 } = {}) {
  let tail = Promise.resolve();
  let lastEnd = 0;
  const cache = new Map();
  return (args, options, execute, settings = {}) => {
    const task = tail.then(async () => {
      const { signal, onLine } = options;
      const aborted = () => ({ code: 1, stderr: '', aborted: true });
      if (signal?.aborted) return aborted();
      const cacheable = args.includes('-J') || args.includes('-j');
      const key = JSON.stringify(args);
      const hit = cache.get(key);
      if (cacheable && hit && now() - hit.at < cacheTtlMs) {
        hit.lines.forEach(line => onLine?.(line));
        return hit.result;
      }
      try {
        if (lastEnd) await sleep(Math.max(0, intervalMs + random() * intervalMs - (now() - lastEnd)), undefined, { signal });
        const clients = settings.clients?.length ? settings.clients : ['default', 'web_safari,mweb'];
        let result;
        for (let attempt = 0; attempt < clients.length; attempt++) {
          if (signal?.aborted) return aborted();
          const lines = [];
          const extractor = `youtube:player_client=${clients[attempt]}${settings.poToken ? `;po_token=${settings.poToken}` : ''}`;
          const extra = ['--extractor-args', extractor];
          if (settings.poProvider) extra.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${settings.poProvider}`);
          result = await execute([...extra, ...args], { ...options, onLine: line => { lines.push(line); onLine?.(line); } });
          if (result.code === 0 && !result.aborted) {
            if (cacheable) {
              cache.set(key, { at: now(), lines, result });
              if (cache.size > 200) cache.delete(cache.keys().next().value);
            }
            return result;
          }
          if (result.aborted || !isYoutubeBotError(result.stderr) && !/HTTP Error (403|429)|requested format is not available/i.test(result.stderr)) return result;
          if (attempt + 1 < clients.length) await sleep(backoffMs * 2 ** attempt + random() * intervalMs, undefined, { signal });
        }
        return result;
      } catch (e) {
        if (signal?.aborted) return aborted();
        throw e;
      } finally { lastEnd = now(); }
    });
    tail = task.catch(() => {});
    return task;
  };
}

/** Only use an identified matching recording, never a merely similar search hit. */
export function bilibiliAlternative(track, candidates) {
  const song = track.song || track;
  return [...candidates].find(candidate => {
    if (candidate.source !== 'bilibili') return false;
    if (track.bilibiliFallbackId === candidate.id) return true;
    const other = candidate.song || candidate;
    return norm(song.title) && norm(song.artist) && norm(song.title) === norm(other.title)
      && norm(song.artist) === norm(other.artist)
      && (!track.version || !candidate.version || track.version === candidate.version)
      && (!track.duration || !candidate.duration || Math.abs(track.duration - candidate.duration) < 10);
  });
}
