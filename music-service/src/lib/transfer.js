// 直连 CDN 的音频传输：断点续传下载 + 支持 Range 的流式转发。
//
// 降级顺序（任何一步失败都自动进入下一步）：
//   同一地址断点续传（Range: bytes=已收-）→ 下一个备用地址 → 由调用方 refresh() 重新取地址 → 调用方降级到 yt-dlp
//
// 超时分两段：
//   connect：发出请求到收到响应头（CDN 无响应）
//   stall：  收到响应后连续 N 秒没有新数据（连接假死，常见于 PCDN 节点）
import { open, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { causeCode, httpFetch, sleep, SourceError, toSourceError } from './http.js';

/** B 站 PCDN（mcdn / szbdyd / 端口直连 IP）不稳定，排到 upos 官方 CDN 之后 */
export function sortCdnUrls(urls) {
  const flaky = (u) => /mcdn\.bilivideo|szbdyd\.com|^https?:\/\/\d+\.\d+\.\d+\.\d+/.test(u);
  return [...new Set(urls.filter(Boolean))].sort((a, b) => flaky(a) - flaky(b));
}

/**
 * 发起一次请求并等到响应头；connect 超时独立于调用方 signal。
 * 返回 { res, ac }，ac 用于之后的卡死检测。
 */
async function openStream(url, { headers, proxy, signal }) {
  const ac = new AbortController();
  const onAbort = () => ac.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const connectTimer = setTimeout(() => ac.abort(new SourceError('TIMEOUT', 'CDN 无响应')), config.transfer.connectTimeoutMs);
  try {
    const res = await httpFetch(url, { headers, proxy, signal: ac.signal });
    return { res, ac, cleanup: () => signal?.removeEventListener('abort', onAbort) };
  } catch (e) {
    signal?.removeEventListener('abort', onAbort);
    throw ac.signal.reason instanceof SourceError ? ac.signal.reason : e;
  } finally {
    clearTimeout(connectTimer);
  }
}

function statusError(status) {
  if (status === 403 || status === 410) return new SourceError('BLOCKED', `CDN 拒绝访问 (HTTP ${status})，地址可能已过期`);
  if (status === 404) return new SourceError('UNAVAILABLE', 'CDN 资源不存在 (HTTP 404)');
  if (status === 416) return new SourceError('UPSTREAM', 'Range 越界 (HTTP 416)');
  return new SourceError('UPSTREAM', `CDN 返回 HTTP ${status}`);
}

/**
 * 下载到文件，支持断点续传与多地址切换。
 * @param {{urls: string[], headers?: object, proxy?: string|null, dest: string, signal?: AbortSignal,
 *          onProgress?: (bytes: number, total: number|null) => void}} opts
 * @returns {Promise<{bytes: number}>}
 */
export async function downloadToFile({ urls, headers = {}, proxy = null, dest, signal, onProgress }) {
  const { maxRetries, stallTimeoutMs } = config.transfer;
  await rm(dest, { force: true });
  const fh = await open(dest, 'w');
  let received = 0;
  let total = null;
  let lastErr = new SourceError('UPSTREAM', '没有可用的下载地址');

  try {
    for (const url of urls) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal?.aborted) throw toSourceError(signal.reason);
        let stream;
        try {
          stream = await openStream(url, { headers: { ...headers, ...(received ? { Range: `bytes=${received}-` } : {}) }, proxy, signal });
          const { res, ac } = stream;
          if (res.status !== 200 && res.status !== 206) throw statusError(res.status);
          if (res.status === 200 && received) {
            // 服务器不支持 Range：只能从头再来
            received = 0;
            await fh.truncate(0);
          }
          const range = res.headers.get('content-range')?.match(/\/(\d+)$/);
          const len = Number(res.headers.get('content-length')) || null;
          total = range ? Number(range[1]) : res.status === 200 ? len : total;

          let stallTimer;
          const arm = () => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => ac.abort(new SourceError('TIMEOUT', `${stallTimeoutMs / 1000}s 没有收到数据`)), stallTimeoutMs);
          };
          arm();
          try {
            for await (const chunk of res.body) {
              await fh.write(chunk, 0, chunk.length, received);
              received += chunk.length;
              onProgress?.(received, total);
              arm();
            }
          } catch (e) {
            throw ac.signal.reason instanceof SourceError ? ac.signal.reason : e;
          } finally {
            clearTimeout(stallTimer);
          }
          if (total && received < total) throw new SourceError('UPSTREAM', `连接提前结束（${received}/${total}）`);
          return { bytes: received };
        } catch (e) {
          lastErr = toSourceError(e, proxy);
          if (signal?.aborted) throw lastErr;
          stream?.ac.abort();
          // 403/404、连不上主机：这个地址没救了，换下一个；其余（超时/断流）在同一地址续传
          const hostDown = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(causeCode(e));
          if (hostDown || lastErr.code === 'BLOCKED' || lastErr.code === 'UNAVAILABLE' || lastErr.code === 'PROXY') {
            console.warn(`[transfer] ${new URL(url).host} 不可用（${lastErr.message}），换下一个地址`);
            break;
          }
          console.warn(`[transfer] 第 ${attempt + 1} 次失败（已收 ${received} 字节）：${lastErr.message}`);
          if (attempt < maxRetries) await sleep(500 * 2 ** attempt, signal);
        } finally {
          stream?.cleanup();
        }
      }
    }
    throw lastErr;
  } finally {
    await fh.close();
  }
}

const PASS_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

/**
 * 把远端音频流转发给浏览器（<audio src> 直接可用，支持拖动进度 = Range）。
 * 依次尝试各地址，第一个返回 200/206 的胜出。
 */
export async function pipeRemote(req, res, { urls, headers = {}, proxy = null, contentType }) {
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const range = req.headers.range && /^bytes=\d*-\d*$/.test(req.headers.range) ? { Range: req.headers.range } : {};
  let lastErr;
  for (const url of urls) {
    let stream;
    try {
      stream = await openStream(url, { headers: { ...headers, ...range }, proxy, signal: ac.signal });
      const up = stream.res;
      if (up.status !== 200 && up.status !== 206) throw statusError(up.status);
      res.status(up.status);
      for (const h of PASS_HEADERS) if (up.headers.get(h)) res.set(h, up.headers.get(h));
      res.set('Content-Type', contentType || up.headers.get('content-type') || 'audio/mp4');
      res.set('Cache-Control', 'no-store');
      const body = Readable.fromWeb(up.body);
      body.on('error', () => res.destroy());
      body.pipe(res);
      return;
    } catch (e) {
      stream?.cleanup();
      lastErr = toSourceError(e, proxy);
      if (ac.signal.aborted) return;
    }
  }
  throw lastErr || new SourceError('UPSTREAM', '没有可用的音频地址');
}
