// 粘贴内容 → 平台 + 视频 ID。
//
// 支持：
//   B 站：BV 号、av 号、bilibili.com/video/BV…?p=2、m.bilibili.com、b23.tv / bili2233.cn 短链、
//         以及 App "分享" 出来的整段文字（"【标题】 https://b23.tv/xxxx"）
//   YouTube：watch?v=、youtu.be/、shorts/、embed/、live/、music.youtube.com
//
// 安全：解析结果只保留经白名单正则校验的 ID，后续请求的 URL 全部由服务端重新拼接；
// 唯一会"跟随"用户输入去请求的是 b23.tv 短链展开，它只请求固定域名、不自动跟随跳转、
// 并校验跳转目标必须是 bilibili.com。
import { config } from '../config.js';
import { httpFetch, SourceError } from './http.js';

const BV_RE = /BV[0-9A-Za-z]{10}/;
const AV_RE = /(?:^|[/?&=\s])av(\d{1,12})(?![\d])/i;
const SHORT_RE = /(?:https?:\/\/)?(b23\.tv|bili2233\.cn)\/([0-9A-Za-z]{4,16})/i;
const YT_ID = /^[\w-]{11}$/;
const YT_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i;

/** 从一段文字里取出第一个 URL（分享文案常带标题和表情） */
function firstUrl(text) {
  const m = text.match(/https?:\/\/[^\s<>"'，。！、）】]+/i);
  return m ? m[0] : null;
}

function pageOf(u) {
  const p = Number(u?.searchParams.get('p'));
  return Number.isInteger(p) && p > 1 && p < 1000 ? p : 1;
}

function parseBilibili(text, u) {
  if (u && !/(^|\.)bilibili\.com$/i.test(u.hostname)) return null;
  const bv = (u ? u.pathname : text).match(BV_RE)?.[0] || (!u && text.match(BV_RE)?.[0]);
  if (bv) return { platform: 'bilibili', bvid: bv, p: pageOf(u) };
  const av = (u ? u.pathname : ` ${text}`).match(AV_RE)?.[1];
  if (av) return { platform: 'bilibili', aid: av, p: pageOf(u) };
  return null;
}

function parseYoutube(u) {
  const host = u.hostname.toLowerCase();
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (YT_HOSTS.test(host)) {
    id = u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/)?.[1] || null;
  } else return null;
  if (!id || !YT_ID.test(id)) throw new SourceError('BAD_INPUT', '没能从 YouTube 链接里找到视频 ID（播放列表 / 频道链接不支持）');
  return { platform: host.startsWith('music.') ? 'ytmusic' : 'youtube', id };
}

/** b23.tv 短链 → 完整链接。最多 3 跳，每跳都校验域名 */
async function expandShort(host, code, signal) {
  let url = `https://${host.toLowerCase()}/${code}`;
  for (let hop = 0; hop < 3; hop++) {
    const res = await httpFetch(url, { method: 'GET', redirect: 'manual', signal, timeout: 6000, proxy: config.bilibili.proxy });
    res.body?.cancel().catch(() => {});
    const loc = res.headers.get('location');
    if (!loc || res.status < 300 || res.status >= 400) break;
    const next = new URL(loc, url);
    if (/(^|\.)bilibili\.com$/i.test(next.hostname)) return next;
    if (!/^(b23\.tv|bili2233\.cn)$/i.test(next.hostname)) break;
    url = next.href;
  }
  throw new SourceError('BAD_INPUT', '短链展开失败：链接已失效，或不是 B 站视频短链');
}

/**
 * @returns {Promise<{platform: 'bilibili', bvid?: string, aid?: string, p: number} | {platform: 'youtube'|'ytmusic', id: string}>}
 */
export async function parseLink(input, { signal } = {}) {
  const text = String(input ?? '').trim().slice(0, 2000);
  if (!text) throw new SourceError('BAD_INPUT', '缺少链接');

  const short = text.match(SHORT_RE);
  if (short) {
    const full = await expandShort(short[1], short[2], signal);
    const r = parseBilibili(full.href, full);
    if (r) return r;
    throw new SourceError('BAD_INPUT', '短链指向的不是 B 站视频（番剧 / 直播 / 专栏暂不支持）');
  }

  const raw = firstUrl(text);
  if (raw) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new SourceError('BAD_INPUT', '链接格式不正确');
    }
    const r = parseBilibili(raw, u) || parseYoutube(u);
    if (r) return r;
    throw new SourceError('BAD_INPUT', `暂不支持 ${u.hostname} 的链接（支持 B 站 / YouTube / YouTube Music）`);
  }

  const r = parseBilibili(text, null);
  if (r) return r;
  throw new SourceError('BAD_INPUT', '无法识别：请粘贴 B 站 / YouTube 链接，或 BV 号 / av 号');
}
