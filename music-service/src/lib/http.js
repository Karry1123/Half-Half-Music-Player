// 统一的 HTTP 工具 + 错误分类。
// 每个音源的失败都被归类为一个 code，聚合层据此给前端可读的状态，而不是让整个请求 500。
import net from 'node:net';
import { fetch as undiciFetch, ProxyAgent, Socks5ProxyAgent } from 'undici';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export class SourceError extends Error {
  /** @param {'TIMEOUT'|'BLOCKED'|'UPSTREAM'|'PARSE'|'UNAVAILABLE'|'NOT_INSTALLED'|'PROXY'|'AUTH'|'BAD_INPUT'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function withTimeout(signal, ms) {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)].filter(Boolean));
}

/** undici 的 "fetch failed" 把真正原因藏在 cause 里（双栈连接时还会是 AggregateError） */
export function causeCode(e) {
  return e?.sys || e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.code || null;
}

/** 把 fetch / AbortSignal 抛出的各种异常统一成 SourceError */
export function toSourceError(e, proxy) {
  if (e instanceof SourceError) return e;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return new SourceError('TIMEOUT', '请求超时');
  const cause = causeCode(e);
  // 代理本身连不上（Clash 没开 / 端口写错）时，错误信息要直接点出代理，而不是笼统的"网络错误"
  if (proxy && (cause === 'ECONNREFUSED' || /proxy|socks/i.test(`${e?.message} ${e?.cause?.message}`))) {
    return new SourceError('PROXY', `代理 ${redact(proxy)} 不可用（${cause || e?.cause?.message || e?.message}），检查代理软件是否开启`);
  }
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(cause)) {
    return Object.assign(new SourceError('UPSTREAM', `网络错误 (${cause})`), { sys: cause }); // sys：底层错误码，调用方据此判断"主机不可达"
  }
  return new SourceError('UPSTREAM', e?.message || String(e));
}

const proxyChecks = new Map(); // proxy → { at, ok }
/**
 * 代理端口能否连上（2s 超时，结果缓存 10s）。
 * yt-dlp 连不上代理时要重试十几秒才报一个含糊的错误，先探测一下可以立即给出明确提示。
 */
export async function assertProxyUp(proxy) {
  if (!proxy) return;
  const hit = proxyChecks.get(proxy);
  if (hit && Date.now() - hit.at < 10_000) {
    if (hit.ok) return;
    throw new SourceError('PROXY', `代理 ${redact(proxy)} 连不上，检查代理软件是否开启、端口是否正确`);
  }
  const u = new URL(proxy);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : u.protocol.startsWith('socks') ? 1080 : 80);
  const ok = await new Promise((resolve) => {
    const s = net.connect({ host: u.hostname.replace(/^\[|\]$/g, ''), port });
    const done = (v) => (s.destroy(), resolve(v));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(2000, () => done(false));
  });
  proxyChecks.set(proxy, { at: Date.now(), ok });
  if (!ok) throw new SourceError('PROXY', `代理 ${redact(proxy)} 连不上，检查代理软件是否开启、端口是否正确`);
}

/** 日志 / 报错里隐藏代理账号密码 */
export const redact = (url) => String(url).replace(/\/\/[^@/]*@/, '//***@');

const dispatchers = new Map();
/** http(s):// → ProxyAgent，socks5(h):// → Socks5ProxyAgent；按 URL 复用连接池 */
export function proxyDispatcher(proxy) {
  if (!proxy) return null;
  if (!dispatchers.has(proxy)) {
    const u = new URL(proxy);
    if (/^socks5h?:$/.test(u.protocol)) dispatchers.set(proxy, new Socks5ProxyAgent(proxy));
    else if (/^https?:$/.test(u.protocol)) dispatchers.set(proxy, new ProxyAgent(proxy));
    else throw new SourceError('PROXY', `不支持的代理协议 ${u.protocol}（支持 http / https / socks5 / socks5h）`);
  }
  return dispatchers.get(proxy);
}

/** fetch，可选走代理。proxy 为空时用 Node 内置 fetch */
export async function httpFetch(url, { proxy, signal, timeout, headers, ...init } = {}) {
  const opts = { ...init, headers: { 'User-Agent': UA, ...headers }, signal: timeout ? withTimeout(signal, timeout) : signal };
  try {
    return proxy ? await undiciFetch(url, { ...opts, dispatcher: proxyDispatcher(proxy) }) : await fetch(url, opts);
  } catch (e) {
    throw toSourceError(e, proxy);
  }
}

export async function fetchJson(url, { method = 'GET', body, headers, signal, timeout = 8000, proxy } = {}) {
  const res = await httpFetch(url, { method, body, headers, signal, timeout, proxy });
  if ([403, 412, 429].includes(res.status)) {
    res.body?.cancel().catch(() => {});
    throw new SourceError('BLOCKED', `HTTP ${res.status}（疑似触发风控/限流）`);
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new SourceError('UPSTREAM', `HTTP ${res.status}`);
  }
  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw toSourceError(e, proxy);
  }
  try {
    return JSON.parse(text);
  } catch {
    // 风控页面通常返回 200 + HTML
    throw new SourceError(text.trimStart().startsWith('<') ? 'BLOCKED' : 'PARSE', '返回内容不是 JSON（可能被风控拦截）');
  }
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/**
 * 指数退避重试：只重试"过一会儿可能就好"的错误（超时 / 网络 / 风控），
 * 输入错误、资源不存在、代理没开等立即失败。
 * @param {(attempt: number) => Promise<T>} fn
 * @template T
 */
export async function retry(fn, { retries = 2, baseMs = 600, signal, retryOn = ['TIMEOUT', 'UPSTREAM', 'BLOCKED'], onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      const err = toSourceError(e);
      if (attempt >= retries || signal?.aborted || !retryOn.includes(err.code)) throw err;
      const wait = baseMs * 2 ** attempt * (0.75 + Math.random() * 0.5); // ±25% 抖动，避免整齐的重试节奏
      onRetry?.(err, attempt + 1, wait);
      await sleep(wait, signal);
    }
  }
}

/** 并发上限为 n 的 map，单项失败返回 undefined 而不是中断全部 */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch {
        out[idx] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
