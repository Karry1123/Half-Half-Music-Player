// 下载任务管理：排队 + 并发上限 + 进度事件（server.js 通过 SSE 推给前端）
//
// 两条下载路径：
//   B 站：直连 CDN 拉 DASH 音轨（可选 Hi-Res 无损 / 192K …），断点续传 + 多地址切换；
//         地址过期则重新解析一次，仍失败降级到 yt-dlp
//   YouTube / YouTube Music：yt-dlp（经 PROXY_URL）
// 之后按目标格式处理：有 ffmpeg 时转封装 / 转码；没有 ffmpeg 时保存原始音轨并在 note 里说明
//
// 格式（format）：
//   m4a      默认。AAC 原样保存；无损音轨保存为 m4a（FLAC 编码，浏览器可直接播放）
//   flac     无损音轨转封装为 .flac（需要 ffmpeg）；有损音轨不转（转了只会变大，音质不会提升）
//   mp3      转码为 VBR V0 mp3（需要 ffmpeg）
//   best / original  不做任何转换
//
// 先写到 downloads/.partial/，完成后再 rename 到正式文件名，中途失败不会留下半截文件。
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { toSourceError } from './lib/http.js';
import { norm } from './lib/rank.js';
import { classifyYtdlpError, detectFfmpeg, runFfmpeg, runYtdlp } from './lib/tools.js';
import { downloadToFile } from './lib/transfer.js';
import { addToLibrary, findInLibrary } from './library.js';
import { parseTrackId } from './providers/index.js';

const TMP_DIR = path.join(config.downloadDir, '.partial');
const ACTIVE = ['queued', 'downloading', 'processing'];

function safeName(s) {
  return (
    s
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
      .replace(/[. ]+$/, '') || 'track'
  );
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}.${ext}`);
  for (let i = 2; existsSync(p); i++) p = path.join(dir, `${base} (${i}).${ext}`);
  return p;
}

/** 原版视频用规范的 歌名/原唱，其余用平台给的标题/歌手（视频平台没有歌手时退回上传者） */
const songName = (t) => t.song || { title: t.title, artist: t.artist || t.uploader || '' };

const num = (s) => (s && s !== 'NA' && s !== 'None' ? Number(s) : null);

/** 对外暴露的任务结构（不含内部字段） */
function pub(job) {
  const { track, _lastEmit, ...rest } = job;
  return { ...rest, cover: track.cover, album: track.album };
}

export class DownloadManager extends EventEmitter {
  jobs = new Map();
  queue = [];
  active = 0;

  async init() {
    await rm(TMP_DIR, { recursive: true, force: true });
    await mkdir(TMP_DIR, { recursive: true });
  }

  list() {
    return [...this.jobs.values()].map(pub).reverse();
  }

  get(id) {
    const j = this.jobs.get(id);
    return j ? pub(j) : null;
  }

  /**
   * @returns {{job: object, existing?: boolean} | {library: object}}
   */
  enqueue(track, { format = 'mp3', quality = null } = {}) {
    for (const j of this.jobs.values()) {
      if (j.trackId === track.id && ACTIVE.includes(j.status)) return { job: pub(j), existing: true };
    }
    const lib = findInLibrary(track.id);
    // 曲库里已有：除非明确要了另一个音质（例如之前下的 192K，这次要 Hi-Res），否则直接复用
    if (lib && !(quality != null && String(lib.qualityId ?? '') !== String(quality))) return { library: lib };

    const job = {
      id: randomUUID().slice(0, 8),
      trackId: track.id,
      ...songName(track),
      source: track.source,
      sourceName: track.sourceName,
      format,
      quality, // 指定音轨：B 站档位 id（30251 / 30280 …）或 YouTube format_id；null = 最佳
      qualityLabel: null,
      status: 'queued',
      progress: 0,
      bytes: 0,
      total: null,
      file: null,
      url: null,
      error: null,
      note: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      track,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this._emit(job, true);
    this._pump();
    return { job: pub(job) };
  }

  _set(job, patch, force = false) {
    Object.assign(job, patch, { updatedAt: Date.now() });
    this._emit(job, force);
  }

  _emit(job, force) {
    // 进度事件节流到 ~4 次/秒，状态变化立即推送
    if (!force && Date.now() - (job._lastEmit || 0) < 250) return;
    job._lastEmit = Date.now();
    this.emit('job', pub(job));
  }

  _pump() {
    while (this.active < config.maxConcurrentDownloads && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this._run(job).finally(() => {
        this.active--;
        this._pump();
      });
    }
  }

  async _run(job) {
    const { track } = job;
    let tmpPath = null;
    try {
      this._set(job, { status: 'downloading' }, true);
      const { provider, sourceId } = parseTrackId(track.id);
      const plan = await provider.resolve(sourceId, { quality: job.quality });
      const result = plan.kind === 'direct' ? await this._directWithFallback(job, plan) : await this._ytdlp(job, plan);
      tmpPath = result.tmpPath;

      // 标题里已含歌手名（常见于视频标题）时不再重复拼接
      const { title, artist } = songName(track);
      const withArtist = artist && !norm(title).includes(norm(artist));
      const base = safeName(withArtist ? `${artist} - ${title}` : title);
      const dest = uniquePath(config.downloadDir, base, result.ext);
      await rename(tmpPath, dest);
      tmpPath = null;
      const file = path.basename(dest);
      const { size } = await stat(dest);

      await addToLibrary({
        trackId: track.id,
        file,
        title,
        artist,
        sourceTitle: track.title,
        artists: track.song ? [track.song.artist] : track.artists,
        album: track.album,
        uploader: track.uploader,
        cover: track.cover,
        duration: track.duration,
        bitrate: result.bitrate ?? track.bitrate,
        quality: result.qualityLabel || null,
        lossless: !!result.lossless,
        qualityId: result.qualityId ?? job.quality ?? null,
        format: result.ext,
        size,
        source: track.source,
        sourceName: track.sourceName,
        version: track.version || null,
        pageUrl: track.pageUrl,
        downloadedAt: new Date().toISOString(),
      });
      const note = result.note !== undefined ? result.note : result.ext === job.format ? null : job.note; // 原始流恰好就是目标格式时无需提示
      this._set(job, { status: 'done', progress: 1, format: result.ext, note, file, url: `/files/${encodeURIComponent(file)}` }, true);
      console.log(`[download] 完成 ${file}`);
    } catch (e) {
      const err = toSourceError(e);
      console.warn(`[download] ${track.id} 失败: ${err.code} ${err.message}`);
      this._set(job, { status: 'error', error: err.message, code: err.code }, true);
      if (tmpPath) await rm(tmpPath, { force: true });
    }
  }

  /** 直连 CDN；地址全部失效时重新解析一次；再失败降级到 yt-dlp */
  async _directWithFallback(job, plan) {
    try {
      return await this._direct(job, plan);
    } catch (e) {
      const err = toSourceError(e);
      if (plan.refresh && (err.code === 'BLOCKED' || err.code === 'UNAVAILABLE')) {
        console.warn(`[download] ${job.trackId} CDN 地址失效（${err.message}），重新解析`);
        try {
          return await this._direct(job, { ...(await plan.refresh()), refresh: null });
        } catch (e2) {
          console.warn(`[download] ${job.trackId} 重新解析后仍失败：${toSourceError(e2).message}`);
        }
      }
      if (!plan.fallback) throw err;
      console.warn(`[download] ${job.trackId} 直连失败（${err.message}），降级到 yt-dlp`);
      const note = `直连下载失败（${err.message}），已改用 yt-dlp`;
      this._set(job, { note, bytes: 0, progress: 0 }, true);
      const r = await this._ytdlp(job, plan.fallback);
      // yt-dlp 自己的提示（如"未安装 ffmpeg"）只在格式确实没转成时才有意义
      return { ...r, note: job.note === note || r.ext === job.format ? note : `${note}；${job.note}` };
    }
  }

  async _direct(job, plan) {
    const q = plan.quality;
    const tmp = path.join(TMP_DIR, `${job.id}.m4s`);
    this._set(job, { status: 'downloading', qualityLabel: q.label, total: q.size || null }, true);
    try {
      await downloadToFile({
        urls: plan.urls,
        headers: plan.headers,
        proxy: plan.proxy,
        dest: tmp,
        onProgress: (bytes, total) => this._set(job, { bytes, total: total || job.total, progress: total ? Math.min(0.99, bytes / total) : job.progress }),
      });
      return await this._postprocess(job, tmp, q);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  /** 原始 DASH 音轨（fMP4）→ 目标格式 */
  async _postprocess(job, tmp, q) {
    const ffmpeg = await detectFfmpeg();
    const fmt = job.format;
    const base = { bitrate: q.bitrate, qualityLabel: q.label, lossless: !!q.lossless, qualityId: String(q.id) };
    const out = (ext) => path.join(TMP_DIR, `${job.id}.${ext}`);
    let note = null;
    if (fmt === 'flac' && !q.lossless) note = `源音轨是有损的 ${q.label}，保存为 m4a（转成 FLAC 只会变大，音质不会提升）`;
    if (q.codec === 'eac3') note = '杜比全景声（E-AC-3）：Chrome / Firefox 无法播放，建议用 Edge / Safari 或系统播放器';

    if (!ffmpeg) {
      const dest = out('m4a');
      await rename(tmp, dest);
      if (fmt === 'mp3') note = '未安装 ffmpeg，无法转为 mp3，保存原始音轨（m4a）';
      else if (fmt === 'flac' && q.lossless) note = '未安装 ffmpeg：无损音轨以 m4a 封装保存（FLAC 编码，音质无损）';
      return { ...base, tmpPath: dest, ext: 'm4a', note };
    }

    this._set(job, { status: 'processing', progress: 0.99 }, true);
    let ext;
    let args;
    if (fmt === 'mp3' && q.codec !== 'mp3') {
      ext = 'mp3';
      args = ['-i', tmp, '-vn', '-c:a', 'libmp3lame', '-q:a', '0'];
      if (q.lossless) note = '已从无损音轨转码为 mp3（V0），如需无损请选 flac / m4a';
      Object.assign(base, { lossless: false, bitrate: null });
    } else if (q.codec === 'flac' && (fmt === 'flac' || fmt === 'best')) {
      ext = 'flac';
      args = ['-i', tmp, '-vn', '-c:a', 'copy'];
    } else if (fmt === 'original') {
      await rename(tmp, out('m4a'));
      return { ...base, tmpPath: out('m4a'), ext: 'm4a', note };
    } else {
      // DASH 分片 MP4 → 普通 m4a（moov 前置），兼容性更好，音频数据不变
      ext = 'm4a';
      args = ['-i', tmp, '-vn', '-c:a', 'copy', '-movflags', '+faststart'];
    }
    await runFfmpeg([...args, '-metadata', `title=${job.title}`, '-metadata', `artist=${job.artist || ''}`, out(ext)]);
    await rm(tmp, { force: true });
    return { ...base, tmpPath: out(ext), ext, note };
  }

  async _ytdlp(job, plan) {
    const ffmpeg = await detectFfmpeg();
    if (job.format === 'flac') this._set(job, { note: 'YouTube 没有无损音源，保存原始音轨（Opus / AAC）' }, true);
    const keep = ['original', 'best', 'flac'].includes(job.format);
    const convert = !!ffmpeg && !keep;
    const pick = job.quality && /^[\w-]{1,20}$/.test(job.quality) && plan.url && !/bilibili/.test(plan.url) ? `${job.quality}/` : '';
    let filePath = null;

    const args = [
      '--no-playlist',
      '--newline',
      '--progress',
      '--progress-template',
      'download:HHPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
      '--print',
      'after_move:HHFILE %(filepath)s',
      '-o',
      path.join(TMP_DIR, `${job.id}.%(ext)s`),
    ];
    if (convert) {
      args.push('-f', `${pick}bestaudio/best`, '-x', '--audio-format', job.format, '--audio-quality', '0', '--embed-metadata');
      if (job.format === 'mp3') args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
    } else {
      // 没有 ffmpeg 无法转码/合并，只取单独的音频流（YouTube itag 140 / B 站 dash 音轨都是 m4a）
      if (!keep) this._set(job, { note: `未安装 ffmpeg，无法转为 ${job.format}，保存原始音频流` }, true);
      args.push('-f', `${pick}bestaudio[ext=m4a]/bestaudio[acodec!=none][vcodec=none]/bestaudio`);
    }
    args.push(...(plan.args || []), '--', plan.url);

    const { code, stderr } = await runYtdlp(args, {
      onLine: (line) => {
        if (line.startsWith('HHPROG ')) {
          const [, d, t, est] = line.split(' ');
          const bytes = num(d);
          const total = num(t) || num(est);
          if (bytes == null) return;
          const progress = total ? Math.min(0.99, bytes / total) : job.progress;
          const status = convert && total && bytes >= total ? 'processing' : 'downloading';
          this._set(job, { bytes, total, progress, status }, status !== job.status);
        } else if (line.startsWith('HHFILE ')) {
          filePath = line.slice(7).trim();
        }
      },
    });
    if (!filePath || !existsSync(filePath)) throw classifyYtdlpError(stderr || `yt-dlp 退出码 ${code}`);
    return { tmpPath: filePath, ext: path.extname(filePath).slice(1) };
  }
}
