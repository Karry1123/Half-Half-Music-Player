/**
 * 统一的曲目结构。所有音源都映射成这个形状。
 * @typedef {object} Track
 * @property {string} id            `${source}:${sourceId}`，下载接口用它定位
 * @property {string} source        平台标签：ytmusic / youtube / bilibili
 * @property {string} sourceName    平台中文名
 * @property {string} sourceId
 * @property {string} title
 * @property {string[]} artists     演唱者（视频平台可能为空或从标题猜测）
 * @property {string} artist        artists.join(' / ')
 * @property {string|null} uploader 上传者 / UP 主 / 频道名
 * @property {string|null} album
 * @property {string|null} cover
 * @property {number|null} duration 秒
 * @property {number|null} plays    播放量
 * @property {number|null} bitrate  kbps
 * @property {boolean} bitrateEstimated  平台未给出时按该平台常见规格估算
 * @property {string|null} format   m4a / mp3 / opus ...
 * @property {string|null} pageUrl  原始页面，前端可跳转核对版本
 * @property {string|null} category 平台分区（B 站：MV / 翻唱 / 音乐综合 …）
 * @property {boolean} official     官方音源 / 官方频道
 * @property {boolean} trusted      可信的搬运 UP 主
 * @property {boolean} artistGuessed 歌手是从 "A - B" 标题里拆出来的（可能与标题顺序颠倒）
 */
export function makeTrack(provider, t) {
  const artists = (t.artists || []).map((a) => a.trim()).filter(Boolean);
  return {
    id: `${provider.name}:${t.sourceId}`,
    source: provider.name,
    sourceName: provider.label,
    sourceId: String(t.sourceId),
    title: t.title?.trim() || '(无标题)',
    artists,
    artist: artists.join(' / '),
    uploader: t.uploader || null,
    album: t.album || null,
    cover: t.cover || null,
    duration: t.duration ? Math.round(t.duration) : null,
    plays: t.plays ?? null,
    bitrate: t.bitrate ? Math.round(t.bitrate) : null,
    bitrateEstimated: !!t.bitrateEstimated,
    format: t.format || null,
    pageUrl: t.pageUrl || null,
    category: t.category || null,
    official: !!t.official,
    trusted: !!t.trusted,
    artistGuessed: !!t.artistGuessed,
  };
}

/** "Artist - Title" 式标题拆分（YouTube 常见） */
export function splitArtistTitle(raw, fallbackArtist) {
  const m = raw.match(/^(.{1,60}?)\s+[-–—]\s+(.+)$/);
  if (m) return { artists: m[1].split(/\s*[,、&/×]\s*|\s+(?:feat\.?|ft\.?)\s+/i), title: m[2], artistGuessed: true };
  return { artists: fallbackArtist ? [fallbackArtist] : [], title: raw, artistGuessed: false };
}

/** "3.6亿" / "183万" / "1.2M" / "12,345" → 数字 */
export function parseCount(s) {
  if (typeof s === 'number') return s;
  const m = String(s ?? '').replace(/,/g, '').match(/([\d.]+)\s*(亿|万|[kKmMbB])?/);
  if (!m) return null;
  const mult = { 亿: 1e8, 万: 1e4, k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 }[m[2]] || 1;
  return Math.round(Number(m[1]) * mult);
}

/** "3:36" / "1:02:03" → 秒 */
export function parseDuration(s) {
  if (typeof s === 'number') return s;
  const parts = String(s ?? '').split(':').map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
