// yt-dlp 系音源：YouTube（视频）
//
// 搜索用 `-j --flat-playlist`（每条结果一行 JSON，流式输出），~2s；超时被杀掉时已拿到的结果依然可用。
import { config } from '../config.js';
import { SourceError } from '../lib/http.js';
import { classifyYtdlpError, detectYtdlp, runYtdlp, ytdlpNetArgs } from '../lib/tools.js';
import { makeTrack, splitArtistTitle } from './track.js';

function ytdlpProvider({ name, label, prefix, idPattern, toUrl, map }) {
  return {
    name,
    label,
    kind: 'ytdlp',
    idPattern,

    async available() {
      return (await detectYtdlp()) ? true : 'yt-dlp 未安装（npm run setup:ytdlp）';
    },

    async search(q, { limit, signal }) {
      const entries = [];
      const args = [...ytdlpNetArgs('youtube'), '-j', '--skip-download', '--ignore-errors', '--flat-playlist', '--', `${prefix}${Math.min(limit * 2, 20)}:${q}`];
      const { stderr, aborted } = await runYtdlp(args, {
        signal,
        onLine: (l) => {
          if (l.startsWith('{')) {
            try {
              entries.push(JSON.parse(l));
            } catch {}
          }
        },
      });
      if (!entries.length) {
        if (aborted) throw new SourceError('TIMEOUT', '搜索超时');
        if (/ERROR/.test(stderr)) throw classifyYtdlpError(stderr);
      }

      const items = [];
      const seen = new Set();
      for (const e of entries) {
        if (!e.id || !e.duration || e.duration < 60 || e.duration > config.search.maxDurationSec) continue;
        const t = map.call(this, e);
        if (!t || seen.has(t.id)) continue;
        seen.add(t.id);
        items.push(t);
      }
      return { items, filtered: entries.length - items.length, partial: aborted };
    },

    async resolve(sourceId) {
      return { kind: 'ytdlp', url: toUrl(sourceId), args: ytdlpNetArgs('youtube') };
    },
  };
}

export const youtube = ytdlpProvider({
  name: 'youtube',
  label: 'YouTube',
  prefix: 'ytsearch',
  idPattern: /^[\w-]{11}$/,
  toUrl: (id) => `https://www.youtube.com/watch?v=${id}`,
  map(e) {
    if (['is_live', 'is_upcoming'].includes(e.live_status)) return null;
    if (e.availability && !['public', 'unlisted'].includes(e.availability)) return null; // 会员/付费/需登录
    const channel = e.channel || e.uploader || '';
    const topic = /\s-\sTopic$/.test(channel); // YouTube Music 自动生成的官方音频频道
    const { artists, title, artistGuessed } = topic
      ? { artists: [channel.replace(/\s-\sTopic$/, '')], title: e.title, artistGuessed: false }
      : splitArtistTitle(e.title, null);
    return makeTrack(this, {
      sourceId: e.id,
      title,
      artists,
      artistGuessed,
      uploader: channel,
      cover: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
      duration: e.duration,
      plays: e.view_count ?? null,
      bitrate: 128,
      bitrateEstimated: true,
      format: 'm4a',
      pageUrl: `https://www.youtube.com/watch?v=${e.id}`,
      official: topic || !!e.channel_is_verified || /vevo$/i.test(channel),
    });
  },
});
