// 哔哩哔哩：原生搜索接口（wbi 签名 + 设备 Cookie），~0.5s 一次拿到 标题/UP 主/时长/播放量/分区。
//
// 音频解析（/api/resolve、下载、流式播放）走 playurl 接口，直接拿 DASH 音轨：
//   30251 Hi-Res 无损（FLAC，需要大会员）· 30250 杜比全景声（E-AC-3，需要大会员）
//   30280 192K · 30232 132K · 30216 64K（AAC）
// 只有配置了自己账号的 Cookie（SESSDATA）才会返回会员音轨；未登录时最高 192K。
//
// 风控处理：
//   - 首次使用时向 /x/frontend/finger/spi 申请 buvid3/buvid4（等同浏览器首次访问），并访问一次首页"预热"
//   - wbi 密钥从 /x/web-interface/nav 获取，6 小时刷新
//   - 所有 API 请求串行限速（BILI_MIN_INTERVAL，默认 300ms）+ 随机抖动
//   - 遇到 412 / -352 / 非 JSON：重新申请设备 Cookie（登录 Cookie 保留），指数退避重试
//   - Cookie 文件（COOKIE_PATH）修改后自动重新加载
// 下载优先直连 CDN（断点续传、多地址切换），失败时降级到 yt-dlp。
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { fetchJson, retry, sleep, SourceError, UA } from '../lib/http.js';
import { sortCdnUrls } from '../lib/transfer.js';
import { makeTrack, parseDuration } from './track.js';

const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16,
  24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
const SESSION_TTL = 6 * 3600 * 1000;
const COOKIE_FILE = path.join(config.cacheDir, 'bilibili-cookies.txt');
const API = 'https://api.bilibili.com';

/** 音轨档位。rank 越小越优先；杜比排最后：Chrome / Firefox 不支持 E-AC-3，只有明确指定时才用 */
export const AUDIO_QUALITIES = {
  30251: { label: 'Hi-Res 无损', codec: 'flac', lossless: true, vip: true, rank: 0 },
  30280: { label: '192K', codec: 'aac', rank: 1 },
  30232: { label: '132K', codec: 'aac', rank: 2 },
  30216: { label: '64K', codec: 'aac', rank: 3 },
  30250: { label: '杜比全景声', codec: 'eac3', vip: true, rank: 4, note: '多数浏览器无法播放 E-AC-3' },
};

// ───────────────────────────── Cookie

/** 支持三种格式：Netscape cookies.txt / 浏览器插件导出的 JSON 数组 / 一行 "k=v; k=v" */
export function parseCookieText(text) {
  const out = new Map();
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return out;
  if (t.startsWith('[') || t.startsWith('{')) {
    const j = JSON.parse(t);
    for (const c of Array.isArray(j) ? j : j.cookies || []) {
      if (c?.name && (!c.domain || /bilibili\.com$/.test(c.domain))) out.set(c.name, String(c.value));
    }
    return out;
  }
  const lines = t.split(/\r?\n/);
  if (lines.some((l) => l.split('\t').length >= 7)) {
    for (const l of lines) {
      const f = l.replace(/^#HttpOnly_/, '').split('\t');
      if (f.length >= 7 && !l.startsWith('# ') && /bilibili\.com$/.test(f[0])) out.set(f[5], f[6].trim());
    }
    return out;
  }
  for (const pair of t.split(/;\s*/)) {
    const i = pair.indexOf('=');
    if (i > 0) out.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return out;
}

const cookieFileMtime = () => {
  const f = config.bilibili.cookieFile;
  return f && existsSync(f) ? statSync(f).mtimeMs : 0;
};

async function userCookies() {
  const cookies = parseCookieText(config.bilibili.cookie);
  const f = config.bilibili.cookieFile;
  if (f) {
    if (!existsSync(f)) console.warn(`[bilibili] COOKIE_PATH 不存在：${f}`);
    else {
      try {
        for (const [k, v] of parseCookieText(await readFile(f, 'utf8'))) cookies.set(k, v);
      } catch (e) {
        console.warn(`[bilibili] Cookie 文件解析失败：${e.message}`);
      }
    }
  }
  return cookies;
}

// ───────────────────────────── 会话（设备 Cookie + wbi 密钥 + 登录信息）

let session = null; // { cookies: Map, mixinKey, at, mtime, account }
let sessionPromise = null;

const cookieHeader = (cookies) => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
function headers(cookies) {
  return { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com', Cookie: cookieHeader(cookies) };
}

async function createSession() {
  const cookies = await userCookies();
  const mtime = cookieFileMtime();
  if (!cookies.has('buvid3')) {
    const spi = await fetchJson(`${API}/x/frontend/finger/spi`, { timeout: 6000, proxy: config.bilibili.proxy });
    cookies.set('buvid3', spi.data.b_3);
    cookies.set('buvid4', encodeURIComponent(spi.data.b_4));
    cookies.set('b_nut', String(Math.floor(Date.now() / 1000)));
  }
  // 像浏览器一样先访问一次首页，未"预热"的设备 Cookie 搜索时更容易被静默返回空结果
  await fetch('https://www.bilibili.com/', { headers: headers(cookies), signal: AbortSignal.timeout(6000) })
    .then((r) => r.body?.cancel())
    .catch(() => {});
  const nav = await fetchJson(`${API}/x/web-interface/nav`, { headers: headers(cookies), timeout: 6000, proxy: config.bilibili.proxy });
  const key = (u) => u.split('/').pop().split('.')[0];
  const raw = key(nav.data.wbi_img.img_url) + key(nav.data.wbi_img.sub_url);
  const mixinKey = MIXIN_TABLE.map((i) => raw[i]).join('').slice(0, 32);

  const d = nav.data || {};
  const account = {
    login: !!d.isLogin,
    name: d.isLogin ? d.uname : null,
    vip: !!d.isLogin && d.vipStatus === 1,
    vipLabel: d.isLogin ? d.vip_label?.text || null : null,
  };
  if (cookies.has('SESSDATA') && !account.login) console.warn('[bilibili] Cookie 里的 SESSDATA 已失效（nav 返回未登录），请重新导出');

  // 给 yt-dlp 用的 Netscape cookies.txt（降级下载时用）
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const lines = [...cookies].map(([k, v]) => ['.bilibili.com', 'TRUE', '/', 'FALSE', exp, k, v].join('\t'));
  await mkdir(config.cacheDir, { recursive: true });
  await writeFile(COOKIE_FILE, `# Netscape HTTP Cookie File\n${lines.join('\n')}\n`);

  if (session?.account?.name !== account.name || !session) {
    console.log(
      `[bilibili] ${
        account.login
          ? `已登录：${account.name}${account.vip ? `（${account.vipLabel || '大会员'}）` : '（非大会员，最高 192K）'}`
          : '未登录（最高 192K；配置 COOKIE_PATH 可解析 Hi-Res 无损）'
      }`,
    );
  }
  return { cookies, mixinKey, at: Date.now(), mtime, account };
}

async function getSession(force = false) {
  const stale = !session || Date.now() - session.at > SESSION_TTL || session.mtime !== cookieFileMtime();
  if (!force && !stale) return session;
  sessionPromise ??= createSession().finally(() => (sessionPromise = null));
  session = await sessionPromise;
  return session;
}

export async function accountInfo() {
  try {
    return (await getSession()).account;
  } catch {
    return null;
  }
}

function signWbi(params, mixinKey) {
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const qs = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${qs}&w_rid=${createHash('md5').update(qs + mixinKey).digest('hex')}`;
}

// ───────────────────────────── 限速 + 重试的 API 调用

let queue = Promise.resolve();
let lastCall = 0;
/** 串行化所有 B 站 API 请求，两次之间至少间隔 minIntervalMs（加 0~40% 抖动） */
function throttle() {
  const turn = queue.then(async () => {
    const gap = config.bilibili.minIntervalMs * (1 + Math.random() * 0.4);
    const wait = lastCall + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
  });
  queue = turn.catch(() => {});
  return turn;
}

/**
 * @param {string} p 接口路径
 * @param {object} params
 * @param {{signed?: boolean, signal?: AbortSignal, timeout?: number, retries?: number}} opts
 */
async function api(p, params, { signed = false, signal, timeout = config.search.timeoutMs, retries = 2 } = {}) {
  return retry(
    async (attempt) => {
      // 被风控后换一套设备 Cookie 再试（登录 Cookie 会保留）
      const s = await getSession(attempt > 0);
      await throttle();
      const qs = signed ? signWbi(params, s.mixinKey) : new URLSearchParams(params).toString();
      const j = await fetchJson(`${API}${p}?${qs}`, { headers: headers(s.cookies), signal, timeout, proxy: config.bilibili.proxy });
      if (j.code === -352 || j.code === -412 || j.code === -509 || j.code === -799) throw new SourceError('BLOCKED', `风控校验 (${j.code})`);
      if (j.code === -101) throw new SourceError('AUTH', '账号未登录或 Cookie 已失效');
      if (j.code === -404 || j.code === 62002 || j.code === 62004) throw new SourceError('UNAVAILABLE', '视频不存在或已被删除');
      if (j.code === -403 || j.code === 87008) throw new SourceError('UNAVAILABLE', '没有权限访问该视频（充电专属 / 付费 / 地区限制）');
      if (j.code !== 0) throw new SourceError('UPSTREAM', j.message || `code ${j.code}`);
      return j.data;
    },
    { retries, signal, onRetry: (e, n, wait) => console.warn(`[bilibili] ${p} ${e.message}，${Math.round(wait)}ms 后第 ${n} 次重试`) },
  );
}

// ───────────────────────────── 视频信息 + 音轨

const ENTITIES = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&nbsp;': ' ' };
const cleanTitle = (s) => s.replace(/<[^>]+>/g, '').replace(/&(quot|amp|lt|gt|#39|nbsp);/g, (e) => ENTITIES[e]);
const https = (u) => (u?.startsWith('//') ? `https:${u}` : u?.replace(/^http:/, 'https:')) || null;

/** sourceId：BV1xxxxxxxxx 或 BV1xxxxxxxxx_p3（多 P 视频的第 3 P） */
export function splitId(sourceId) {
  const [bvid, p] = sourceId.split('_p');
  return { bvid, p: Number(p) || 1 };
}
const joinId = (bvid, p) => (p > 1 ? `${bvid}_p${p}` : bvid);

const viewCache = new Map();
/** @param {{bvid?: string, aid?: string}} ref */
export async function videoInfo(ref, { signal } = {}) {
  const key = ref.bvid || `av${ref.aid}`;
  const hit = viewCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const data = await api('/x/web-interface/wbi/view', ref.bvid ? { bvid: ref.bvid } : { aid: ref.aid }, { signed: true, signal });
  viewCache.set(key, { at: Date.now(), data });
  if (viewCache.size > 300) viewCache.delete(viewCache.keys().next().value);
  return data;
}

function mapAudio(a, duration) {
  if (!a) return null;
  const meta = AUDIO_QUALITIES[a.id] || { label: `${Math.round(a.bandwidth / 1000)}K`, codec: 'aac', rank: 9 };
  return {
    id: a.id,
    ...meta,
    bitrate: Math.round((a.bandwidth || 0) / 1000) || null,
    size: a.bandwidth && duration ? Math.round((a.bandwidth / 8) * duration) : null,
    mime: a.mimeType || a.mime_type || 'audio/mp4',
    codecs: a.codecs,
    urls: sortCdnUrls([a.baseUrl || a.base_url, ...(a.backupUrl || a.backup_url || [])]),
  };
}

/**
 * 取一个分 P 的全部音轨（含 CDN 地址，约 2 小时有效）。
 * @returns {Promise<{qualities: object[], duration: number}>}
 */
export async function audioStreams(bvid, cid, { signal } = {}) {
  const d = await api(
    '/x/player/wbi/playurl',
    // fnval 4048 = DASH + HDR + 4K + 杜比音频 + 杜比视界 + 8K + AV1，全部声明才会返回杜比 / 无损音轨
    { bvid, cid, qn: 0, fnver: 0, fnval: 4048, fourk: 1 },
    { signed: true, signal },
  );
  if (!d.dash) throw new SourceError('UNAVAILABLE', '该视频没有 DASH 音轨（可能是试看片段或付费内容）');
  const duration = d.dash.duration || Math.round((d.timelength || 0) / 1000);
  const list = [...(d.dash.audio || []), ...(d.dash.dolby?.audio || []), ...(d.dash.flac?.audio ? [d.dash.flac.audio] : [])]
    .map((a) => mapAudio(a, duration))
    .filter((q) => q?.urls.length);
  const seen = new Set();
  const qualities = list.filter((q) => !seen.has(q.id) && seen.add(q.id)).sort((a, b) => a.rank - b.rank);
  if (!qualities.length) throw new SourceError('UNAVAILABLE', '没有可用的音轨');
  return { qualities, duration };
}

/** 选择音轨：指定 id 且存在则用它，否则按 rank 取最好的（不主动选杜比） */
export function pickQuality(qualities, wanted) {
  const id = Number(wanted);
  return qualities.find((q) => q.id === id) || qualities.find((q) => q.codec !== 'eac3') || qualities[0];
}

/**
 * 链接 / ID → 完整信息（曲目 + 可用音质 + 账号状态）
 * @param {{bvid?: string, aid?: string, p?: number}} ref
 */
export async function resolveVideo(ref, { signal } = {}) {
  const v = await videoInfo(ref, { signal });
  const pages = v.pages || [];
  const page = pages.find((x) => x.page === (ref.p || 1)) || pages[0];
  if (!page) throw new SourceError('UNAVAILABLE', '视频没有可播放的分 P');
  const { qualities, duration } = await audioStreams(v.bvid, page.cid, { signal });
  const best = pickQuality(qualities);
  const { account } = await getSession();
  const multi = pages.length > 1;

  const track = makeTrack(bilibili, {
    sourceId: joinId(v.bvid, page.page),
    title: multi && page.part && page.part !== v.title ? `${cleanTitle(v.title)} · ${page.part}` : cleanTitle(v.title),
    artists: [],
    uploader: v.owner?.name,
    cover: https(v.pic),
    duration: page.duration || duration,
    plays: v.stat?.view ?? null,
    format: best.codec === 'flac' ? 'flac' : 'm4a',
    bitrate: best.bitrate,
    bitrateEstimated: false,
    pageUrl: `https://www.bilibili.com/video/${v.bvid}${page.page > 1 ? `?p=${page.page}` : ''}`,
    category: v.tname,
    trusted: config.bilibili.trustedUploaders.includes(v.owner?.name),
  });
  let hint = null;
  if (!account.login) hint = '未登录，最高 192K；配置 COOKIE_PATH（大会员账号）可解析 Hi-Res 无损';
  else if (!account.vip) hint = '当前账号不是大会员，最高 192K';
  else if (!qualities.some((q) => q.lossless)) hint = 'UP 主没有上传无损音轨，192K 已是该视频最高音质';
  return {
    track,
    qualities: qualities.map(({ urls, rank, ...q }) => q),
    best: best.id,
    account,
    hint,
    pages: multi ? pages.map((x) => ({ page: x.page, part: x.part, duration: x.duration })) : undefined,
  };
}

// ───────────────────────────── 搜索

async function searchOnce(q, signal, force) {
  if (force) await getSession(true);
  const d = await api('/x/web-interface/wbi/search/type', { search_type: 'video', keyword: q, page: 1 }, { signed: true, signal, retries: 1 });
  return { list: d?.result || [], total: d?.numResults || 0 };
}

export const bilibili = {
  name: 'bilibili',
  label: '哔哩哔哩',
  kind: 'http',
  idPattern: /^BV[0-9A-Za-z]{10}(?:_p\d{1,3})?$/,

  async available() {
    return true;
  },

  async search(q, { limit, signal }) {
    // 风控有两种：显式（412 / -352，api() 内已重试）和静默（code 0 但结果为空）。静默时换一套设备 Cookie 再试一次
    let res = await searchOnce(q, signal, false);
    if (!res.list.length) res = await searchOnce(q, signal, true);
    const { list, total } = res;
    if (!list.length && total > 0) {
      throw new SourceError('BLOCKED', '静默风控：结果总数非零但列表为空（短时间内搜索过多），稍后再试或配置 COOKIE_PATH');
    }
    const trusted = new Set(config.bilibili.trustedUploaders);
    const items = [];
    for (const v of list) {
      const duration = parseDuration(v.duration);
      // 过短是片段，过长是合集
      if (!v.bvid || !duration || duration < 60 || duration > config.search.maxDurationSec) continue;
      items.push(
        makeTrack(this, {
          sourceId: v.bvid,
          title: cleanTitle(v.title),
          artists: [],
          uploader: v.author,
          cover: https(v.pic),
          duration,
          plays: v.play,
          format: 'm4a',
          bitrate: 192, // DASH 音轨 30280 = 192K，搜索阶段不请求播放信息，按此估算（/api/resolve 给出真实档位）
          bitrateEstimated: true,
          pageUrl: `https://www.bilibili.com/video/${v.bvid}`,
          category: v.typename,
          trusted: trusted.has(v.author),
        }),
      );
    }
    return { items: items.slice(0, limit * 2), filtered: list.length - items.length };
  },

  /**
   * 下载 / 播放计划：优先直连 CDN；refresh() 重新取地址（过期 / 全部 403 时用）；fallback 为 yt-dlp。
   * @param {string} sourceId
   * @param {{quality?: number|string}} [opts]
   */
  async resolve(sourceId, { quality } = {}) {
    const { bvid, p } = splitId(sourceId);
    const fallback = {
      kind: 'ytdlp',
      url: `https://www.bilibili.com/video/${bvid}${p > 1 ? `?p=${p}` : ''}`,
      args: ['--cookies', COOKIE_FILE, ...(config.bilibili.proxy ? ['--proxy', config.bilibili.proxy] : [])],
    };
    const direct = async () => {
      const v = await videoInfo({ bvid });
      const page = v.pages?.find((x) => x.page === p) || v.pages?.[0];
      if (!page) throw new SourceError('UNAVAILABLE', '视频没有可播放的分 P');
      const { qualities } = await audioStreams(bvid, page.cid);
      const q = pickQuality(qualities, quality);
      return {
        kind: 'direct',
        quality: q,
        urls: q.urls,
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
        proxy: config.bilibili.proxy,
      };
    };
    try {
      return { ...(await direct()), refresh: direct, fallback };
    } catch (e) {
      if (e.code === 'UNAVAILABLE') throw e;
      console.warn(`[bilibili] 音轨解析失败（${e.message}），降级到 yt-dlp`);
      await getSession().catch(() => {}); // 确保 yt-dlp 用的 cookies.txt 已生成
      return fallback;
    }
  },
};
