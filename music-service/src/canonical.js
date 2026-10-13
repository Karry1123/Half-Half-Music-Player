// 原唱识别：这首歌的"原版"是谁唱的？
//
// 证据来源：
//   1. YouTube Music 官方曲库：同名歌曲按播放量排序。原唱的播放量通常比翻唱高几个数量级
//      （告白氣球 周杰倫 3.6 亿 vs 翻唱 2 次）
//   2. 网易云 originCoverType：1 = 原唱、2 = 翻唱。只用作判断，不用作下载源
//      （网易云免费曲库里几乎没有大牌原唱，实测 8 首热门歌 0 首可免费下载）
//
// 同名不同歌是正常的（如"起风了"有 买辣椒也用券 与 吴青峰 两首不同的歌），所以结果是一个列表。
import { config } from './config.js';
import { fetchJson } from './lib/http.js';
import { artistAliases, coreTitle, isCover, isLive, norm } from './lib/rank.js';
import { searchYtMusic } from './providers/ytmusic.js';

const MIN_PLAYS = 50_000; // 低于这个播放量的官方曲目不足以证明是原唱
const RELATIVE = 0.05; // 至少达到头部原唱播放量的 5%
const MAX_ORIGINALS = 3;

async function neteaseHints(q) {
  const j = await fetchJson(`https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(q)}&type=1&limit=30`, {
    headers: { Referer: 'https://music.163.com/' },
    timeout: config.search.timeoutMs,
  });
  return (j.result?.songs || []).map((s) => ({
    title: s.name,
    artists: (s.ar || []).map((a) => a.name),
    duration: Math.round(s.dt / 1000),
    original: s.originCoverType === 1,
    cover: s.originCoverType === 2,
    pop: s.pop || 0,
  }));
}

/**
 * @returns {Promise<{originals: Array<{artist: string, aliases: string[], titles: string[], duration: number|null, plays: number|null, evidence: string[]}>, errors: string[]}>}
 */
export async function findOriginals(q) {
  const nq = norm(q);
  const errors = [];
  const [ytm, ne] = await Promise.all([
    searchYtMusic(q).catch((e) => (errors.push(`YouTube Music: ${e.message}`), [])),
    neteaseHints(q).catch((e) => (errors.push(`网易云: ${e.message}`), [])),
  ]);

  // 标题要与关键词对得上，且不能是 live / 翻唱 / 变速等变体
  const titleOk = (title, album = '') => {
    const ct = coreTitle(title);
    const text = norm(`${title} ${album}`);
    return ct.length >= 1 && (nq === ct || ([...ct].length >= 2 && nq.includes(ct))) && !isLive(text, nq) && !isCover(text, nq);
  };

  const groups = new Map(); // 主歌手 → 证据
  const group = (name) => {
    const key = norm(name);
    if (!groups.has(key)) groups.set(key, { artist: name, displayTitle: null, aliases: new Set(), titles: new Set(), duration: null, plays: 0, neOriginal: false, neCover: false, evidence: [] });
    return groups.get(key);
  };

  for (const s of ytm) {
    if (!titleOk(s.title, s.album) || !s.artists[0]) continue;
    const g = group(s.artists[0]);
    if ((s.plays || 0) > g.plays) {
      g.plays = s.plays || 0;
      g.duration = s.duration;
      g.displayTitle = s.title;
    }
    g.titles.add(coreTitle(s.title));
    g.evidence.push(`YouTube Music ${s.plays ?? '?'} 次播放`);
  }
  for (const s of ne) {
    if (!titleOk(s.title) || !s.artists[0]) continue;
    // 网易云的歌手名可能是简体，YouTube Music 是繁体；norm 后同一个 key
    const g = group(s.artists[0]);
    g.titles.add(coreTitle(s.title));
    if (s.original && s.pop >= 50) {
      g.neOriginal = true;
      g.duration ??= s.duration;
      g.displayTitle ??= s.title;
      g.evidence.push('网易云标记为原唱');
    }
    if (s.cover) g.neCover = true;
  }

  let list = [...groups.values()];
  // 关键词里带了歌手名（"晴天 周杰伦"）→ 只认这个歌手
  const named = list.filter((g) => artistAliases(g.artist).some((a) => a.length >= 2 && nq.includes(a)));
  if (named.length) list = named;

  const top = Math.max(0, ...list.map((g) => g.plays));
  const originals = list
    .filter((g) => {
      if (g.neCover && !g.neOriginal) return false; // 网易云明确标为翻唱（如 起风了·周深）
      if (g.neOriginal) return true;
      return g.plays >= MIN_PLAYS && g.plays >= top * RELATIVE;
    })
    .sort((a, b) => b.plays - a.plays || b.neOriginal - a.neOriginal)
    .slice(0, MAX_ORIGINALS)
    .map((g) => ({
      artist: g.artist,
      aliases: artistAliases(g.artist),
      titles: [...g.titles].filter((t) => [...t].length >= 2 || t === nq),
      // 用于下载后的文件名/曲库标题："光年之外 (電影《Passengers》中文主題曲)" → "光年之外"
      displayTitle: (g.displayTitle || q).replace(/s*[(（【[].*$/, '').trim() || g.displayTitle || q,
      duration: g.duration,
      plays: g.plays || null,
      evidence: [...new Set(g.evidence)].slice(0, 3),
    }));

  return { originals, errors };
}
