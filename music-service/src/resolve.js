// 链接解析 + 可播放地址：/api/resolve 与 /api/stream 共用。
//
//   B 站：playurl 接口（见 providers/bilibili.js），返回真实音轨档位与 CDN 地址
//   YouTube / YouTube Music：yt-dlp -J 完整解析（经 PROXY_URL），列出所有纯音频格式
import { config } from './config.js';
import { SourceError } from './lib/http.js';
import { parseLink } from './lib/links.js';
import { classifyYtdlpError, runYtdlp, ytdlpNetArgs } from './lib/tools.js';
import { bilibili, resolveVideo } from './providers/bilibili.js';
import { parseTrackId } from './providers/index.js';
import { makeTrack, splitArtistTitle } from './providers/track.js';
import { youtube } from './providers/ytdlp.js';
import { ytmusic } from './providers/ytmusic.js';
import { trackCache } from './search.js';

/** yt-dlp 输出一条 JSON；整体超时后杀进程 */
async function ytdlpJson(args, timeoutMs = config.resolve.timeoutMs) {
  let json = null;
  const signal = AbortSignal.timeout(timeoutMs);
  const { stderr, aborted } = await runYtdlp([...ytdlpNetArgs('youtube'), ...args], {
    signal,
    onLine: (l) => {
      if (l.startsWith('{')) {
        try {
          json = JSON.parse(l);
        } catch {}
      }
    },
  });
  if (json) return json;
  if (aborted) throw new SourceError('TIMEOUT', `YouTube 解析超时（${timeoutMs / 1000}s）${config.youtube.proxy ? '' : '：国内网络请配置 PROXY_URL'}`);
  throw classifyYtdlpError(stderr || 'yt-dlp 没有返回结果');
}

const LABEL = { opus: 'Opus', mp4a: 'AAC', vorbis: 'Vorbis', flac: 'FLAC' };

function youtubeQualities(info) {
  return (info.formats || [])
    .filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none' && f.url && !/^(m3u8|http_dash_segments)/.test(f.protocol || ''))
    .filter((f) => !/drc/i.test(f.format_id)) // 动态范围压缩版，音质更差
    .map((f) => {
      const codec = f.acodec.split('.')[0];
      const bitrate = Math.round(f.abr || f.tbr || 0) || null;
      return {
        id: f.format_id,
        label: `${LABEL[codec] || codec} ${bitrate ? `${bitrate}K` : ''}`.trim(),
        codec,
        ext: f.ext,
        bitrate,
        size: f.filesize || f.filesize_approx || (bitrate && info.duration ? Math.round((bitrate * 1000 * info.duration) / 8) : null),
        lossless: codec === 'flac',
      };
    })
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
}

async function resolveYoutube(id, platform) {
  const provider = platform === 'ytmusic' ? ytmusic : youtube;
  const url = platform === 'ytmusic' ? `https://music.youtube.com/watch?v=${id}` : `https://www.youtube.com/watch?v=${id}`;
  const info = await ytdlpJson(['-J', '--no-playlist', '--', url]);
  if (info.live_status === 'is_live' || info.live_status === 'is_upcoming') throw new SourceError('UNAVAILABLE', '直播 / 预告视频无法下载');
  const qualities = youtubeQualities(info);
  if (!qualities.length) throw new SourceError('UNAVAILABLE', '没有可用的纯音频格式');

  // YouTube Music 的官方音轨带 track / artist 元数据；普通视频从 "歌手 - 歌名" 标题里拆
  const channel = (info.channel || info.uploader || '').replace(/\s-\sTopic$/, '');
  const meta = info.track
    ? { title: info.track, artists: String(info.artist || info.creator || channel).split(/,\s*/), artistGuessed: false }
    : splitArtistTitle(info.title, null);
  const best = qualities[0];
  const track = makeTrack(provider, {
    sourceId: id,
    title: meta.title,
    artists: meta.artists,
    artistGuessed: meta.artistGuessed,
    uploader: info.channel || info.uploader,
    album: info.album || null,
    cover: info.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    duration: info.duration,
    plays: info.view_count ?? null,
    bitrate: best.bitrate,
    bitrateEstimated: false,
    format: best.ext,
    pageUrl: url,
    official: !!info.track || /\s-\sTopic$/.test(info.channel || '') || !!info.channel_is_verified,
  });
  return {
    track,
    qualities,
    best: best.id,
    account: null,
    hint: null,
  };
}

/**
 * 粘贴的链接 → { track, qualities, best, account, hint, pages? }
 * 解析出的 track 写入 trackCache，之后 POST /api/download { id } 即可复用元数据。
 */
export async function resolveLink(input) {
  const link = await parseLink(input);
  const t0 = Date.now();
  const r = link.platform === 'bilibili' ? await resolveVideo(link) : await resolveYoutube(link.id, link.platform);
  trackCache.set(r.track.id, { ...r.track, resolvedQualities: r.qualities });
  return { ...r, platform: link.platform, ms: Date.now() - t0 };
}

// ───────────────────────────── 流式播放地址

const streamCache = new Map(); // key → { at, src }
const STREAM_TTL = 50 * 60_000; // B 站地址约 2h、YouTube 约 6h 过期，保守取 50 分钟

/**
 * 曲目 id + 音质 → 可直接拉流的地址列表。
 * @returns {Promise<{urls: string[], headers: object, proxy: string|null, contentType: string, quality: object}>}
 */
export async function streamSource(id, quality, { fresh = false } = {}) {
  const parsed = parseTrackId(id);
  if (!parsed) throw new SourceError('BAD_INPUT', '无效的曲目 id');
  const key = `${id}|${quality || 'best'}`;
  const hit = streamCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < STREAM_TTL) return hit.src;

  let src;
  if (parsed.provider === bilibili) {
    const plan = await bilibili.resolve(parsed.sourceId, { quality });
    if (plan.kind !== 'direct') throw new SourceError('UPSTREAM', 'B 站音轨解析失败，暂时无法在线播放（可以先下载）');
    const { urls, rank, ...q } = plan.quality;
    src = { urls: plan.urls, headers: plan.headers, proxy: plan.proxy, contentType: plan.quality.mime || 'audio/mp4', quality: q };
  } else {
    if (quality && !/^[\w-]{1,20}$/.test(String(quality))) throw new SourceError('BAD_INPUT', '无效的音质参数');
    const { url } = await parsed.provider.resolve(parsed.sourceId);
    const fmt = quality ? `${quality}/bestaudio[ext=m4a]/bestaudio` : 'bestaudio[ext=m4a]/bestaudio';
    const info = await ytdlpJson(['-j', '--no-playlist', '-f', fmt, '--', url]);
    if (!info.url) throw new SourceError('UNAVAILABLE', '没有拿到音频地址');
    src = {
      urls: [info.url],
      headers: info.http_headers || {},
      proxy: config.youtube.proxy,
      contentType: info.ext === 'webm' ? 'audio/webm' : 'audio/mp4',
      quality: { id: info.format_id, codec: (info.acodec || '').split('.')[0], bitrate: Math.round(info.abr || 0) || null, ext: info.ext },
    };
  }
  streamCache.set(key, { at: Date.now(), src });
  if (streamCache.size > 200) streamCache.delete(streamCache.keys().next().value);
  return src;
}
