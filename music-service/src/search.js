// 聚合搜索：并发查询所有音源（任何一个失败/超时都只影响它自己），
// 再按"原唱识别"给每条结果判定版本，默认只返回原版。
import { findOriginals } from './canonical.js';
import { config } from './config.js';
import { SourceError, toSourceError } from './lib/http.js';
import { classify, score, VERSION_LABEL, VERSION_ORDER } from './lib/rank.js';
import { providers, timeoutFor } from './providers/index.js';

const GRACE_MS = 1500; // provider 收到 abort 后整理"部分结果"的宽限期

/** 搜索出现过的曲目，下载时用于取回元数据（标题、封面等） */
export const trackCache = new Map();
const responseCache = new Map();

function remember(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}

async function runProvider(p, q, limit) {
  const t0 = Date.now();
  const base = { source: p.name, label: p.label };
  const avail = await p.available();
  if (avail !== true) return { ...base, ok: false, skipped: true, code: 'NOT_INSTALLED', error: avail, ms: 0, items: [] };

  const timeout = timeoutFor(p);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new SourceError('TIMEOUT', `超时（${timeout}ms）`)), timeout);
  let hardTimer;
  try {
    // 双保险：signal 让 provider 主动收尾；hard deadline 防止某个 provider 无视 signal 卡死
    const hardDeadline = new Promise((_, reject) => {
      hardTimer = setTimeout(() => reject(new SourceError('TIMEOUT', `超时（${timeout}ms）`)), timeout + GRACE_MS);
    });
    const res = await Promise.race([p.search(q, { limit, signal: ac.signal }), hardDeadline]);
    return { ...base, ok: true, partial: !!res.partial || ac.signal.aborted, filtered: res.filtered || 0, ms: Date.now() - t0, items: res.items };
  } catch (e) {
    const err = ac.signal.aborted ? new SourceError('TIMEOUT', `超时（${timeout}ms）`) : toSourceError(e);
    console.warn(`[search] ${p.name} 失败: ${err.code} ${err.message}`);
    return { ...base, ok: false, code: err.code, error: err.message, ms: Date.now() - t0, items: [] };
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
  }
}

export function selectProviders(sources) {
  if (!sources) return providers;
  const wanted = new Set(sources.split(',').map((s) => s.trim()));
  return providers.filter((p) => wanted.has(p.name));
}

/**
 * @param {object} opts
 * @param {'original'|'all'} [opts.versions] original：只要原版（识别不出原唱时退化为全部非翻唱结果）
 */
export async function aggregateSearch(q, { sources, limit = config.search.perSourceLimit, versions = 'original' } = {}) {
  const selected = selectProviders(sources);
  const cacheKey = JSON.stringify([q.toLowerCase(), selected.map((p) => p.name), limit]);
  let full = responseCache.get(cacheKey);
  if (!full || Date.now() - full.at > config.search.cacheTtlMs) {
    full = { at: Date.now(), body: await searchAll(q, selected, limit) };
    if (full.body.sources.some((s) => s.ok)) remember(responseCache, cacheKey, full, 200); // 全部失败不缓存
  } else full = { ...full, body: { ...full.body, cached: true } };

  const { results, ...rest } = full.body;
  const shown =
    versions === 'all'
      ? results
      : results.filter((t) => t.version === 'original' || (!rest.originals.length && t.version === 'unknown'));
  return {
    ...rest,
    versions,
    total: shown.length,
    hidden: results.length - shown.length,
    counts: Object.fromEntries(Object.keys(VERSION_ORDER).map((v) => [v, results.filter((t) => t.version === v).length])),
    results: shown,
  };
}

async function searchAll(q, selected, limit) {
  const t0 = Date.now();
  const [canon, ...runs] = await Promise.all([findOriginals(q), ...selected.map((p) => runProvider(p, q, limit))]);
  const { originals } = canon;

  const results = runs
    .flatMap((r) =>
      r.items.map((t, i) => {
        const { version, singer } = classify(t, originals, q);
        // 视频平台标题五花八门，原版/现场附上规范的 歌名 + 原唱，下载后用作文件名和曲库标题
        const song = version === 'original' ? { title: singer.displayTitle, artist: singer.artist } : null;
        return { ...t, version, versionLabel: VERSION_LABEL[version], song, score: score(t, q, i) };
      }),
    )
    .sort((a, b) => VERSION_ORDER[a.version] - VERSION_ORDER[b.version] || b.score - a.score);

  for (const t of results) remember(trackCache, t.id, t, 5000);

  return {
    query: q,
    tookMs: Date.now() - t0,
    originals: originals.map(({ artist, duration, plays, evidence }) => ({ artist, duration, plays, evidence })),
    originalsErrors: canon.errors,
    sources: runs.map(({ items, ...status }) => ({
      ...status,
      count: items.length,
      originals: results.filter((t) => t.source === status.source && t.version === 'original').length,
    })),
    results,
  };
}
