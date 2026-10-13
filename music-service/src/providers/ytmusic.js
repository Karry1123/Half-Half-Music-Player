// YouTube Music：官方音源（唱片公司上架的 Art Track），是"歌手原版"最可靠的免费来源。
// 直接调用 YouTube Music 网页端的 innertube 搜索接口（与 yt-dlp / ytmusicapi 相同），
// 单次请求即可拿到 歌手 / 专辑 / 时长 / 播放量，~0.5s。下载走 yt-dlp。
import { config } from '../config.js';
import { fetchJson, SourceError, UA } from '../lib/http.js';
import { makeTrack, parseCount, parseDuration } from './track.js';
import { ytdlpNetArgs } from '../lib/tools.js';

const ENDPOINT = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';
const SONGS_FILTER = 'EgWKAQIIAWoMEA4QChADEAQQCRAF'; // 搜索页"歌曲"分类
const CONTEXT = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250101.01.00', hl: 'zh-CN', gl: 'HK' } };

const pageType = (run) => run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;

function parseItem(item) {
  const m = item.musicResponsiveListItemRenderer;
  if (!m) return null;
  const cols = m.flexColumns.map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
  const videoId =
    m.playlistItemData?.videoId ||
    m.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (!videoId) return null;

  const meta = cols[1] || [];
  let artists = meta.filter((r) => pageType(r) === 'MUSIC_PAGE_TYPE_ARTIST').map((r) => r.text);
  if (!artists.length) artists = [meta.map((r) => r.text).join('').split(' • ')[0]]; // 无链接的歌手名
  const album = meta.find((r) => pageType(r) === 'MUSIC_PAGE_TYPE_ALBUM')?.text || null;
  const durationText = [...meta].reverse().find((r) => /^\d+(:\d+){1,2}$/.test(r.text))?.text;
  const playsText = (cols[2] || []).map((r) => r.text).join('');
  const thumb = m.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url || null;

  return {
    videoId,
    title: (cols[0] || []).map((r) => r.text).join(''),
    artists,
    album,
    duration: parseDuration(durationText),
    plays: playsText ? parseCount(playsText) : null,
    cover: thumb ? thumb.replace(/=w\d+-h\d+.*$/, '=w400-h400-l90-rj') : null,
  };
}

// 原唱识别也要用同一份结果：同一关键词 60s 内只请求一次
const memo = new Map();
export function searchYtMusic(q) {
  const key = q.toLowerCase();
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.promise;
  const promise = fetchJson(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://music.youtube.com', Referer: 'https://music.youtube.com/' },
    body: JSON.stringify({ context: CONTEXT, query: q, params: SONGS_FILTER }),
    timeout: config.search.timeoutMs,
    proxy: config.youtube.proxy,
  }).then((j) => {
    const sections = j.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents;
    if (!sections) throw new SourceError('PARSE', 'YouTube Music 返回结构变化');
    return sections.flatMap((s) => s.musicShelfRenderer?.contents || []).map(parseItem).filter(Boolean);
  });
  promise.catch(() => memo.delete(key));
  memo.set(key, { at: Date.now(), promise });
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return promise;
}

export const ytmusic = {
  name: 'ytmusic',
  label: 'YouTube Music',
  kind: 'http',
  idPattern: /^[\w-]{11}$/,

  async available() {
    return true;
  },

  async search(q, { limit }) {
    const songs = await searchYtMusic(q);
    const items = songs.slice(0, limit * 2).map((s) =>
      makeTrack(this, {
        sourceId: s.videoId,
        title: s.title,
        artists: s.artists,
        album: s.album,
        cover: s.cover,
        duration: s.duration,
        plays: s.plays,
        bitrate: 128, // 官方音轨 itag 140 = AAC 128k；Opus 251 约 160k
        bitrateEstimated: true,
        format: 'm4a',
        pageUrl: `https://music.youtube.com/watch?v=${s.videoId}`,
        official: true,
      }),
    );
    return { items, filtered: 0 };
  },

  async resolve(sourceId) {
    return { kind: 'ytdlp', url: `https://music.youtube.com/watch?v=${sourceId}`, args: ytdlpNetArgs('youtube') };
  },
};
