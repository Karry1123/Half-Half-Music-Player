import { config } from '../config.js';
import { bilibili } from './bilibili.js';
import { youtube } from './ytdlp.js';
import { ytmusic } from './ytmusic.js';

// 网易云 / QQ（Meting）已移除：免费曲库里几乎没有原唱（实测 8 首热门歌 0 首可下载），只保留网易云作原唱识别线索（canonical.js）
// SoundCloud 已移除：结果几乎都是翻唱/搬运，原版极少
export const providers = [ytmusic, bilibili, youtube];

export function getProvider(name) {
  return providers.find((p) => p.name === name);
}

export function timeoutFor(provider) {
  return provider.kind === 'ytdlp' ? config.search.ytdlpTimeoutMs : config.search.timeoutMs;
}

/**
 * 解析并校验曲目 id（`source:sourceId`）。
 * sourceId 会被拼进 URL / yt-dlp 参数，所以必须用各平台的白名单正则严格校验。
 */
export function parseTrackId(id) {
  const m = typeof id === 'string' && id.match(/^([\w-]{1,32}):(.{1,80})$/);
  if (!m) return null;
  const provider = getProvider(m[1]);
  if (!provider || !provider.idPattern.test(m[2])) return null;
  return { provider, sourceId: m[2] };
}
