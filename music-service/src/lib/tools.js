// yt-dlp / ffmpeg 探测与进程封装
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { assertProxyUp, SourceError } from './http.js';

const isWin = process.platform === 'win32';

function probe(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.toString().trim().split(/\r?\n/)[0]);
    });
  });
}

let ytdlpPromise;
/** @returns {Promise<{cmd: string, pre: string[], version: string} | null>} */
export function detectYtdlp() {
  ytdlpPromise ??= (async () => {
    const venv = path.join(config.root, '.venv', isWin ? 'Scripts/yt-dlp.exe' : 'bin/yt-dlp');
    const candidates = [
      config.ytdlpPath && { cmd: config.ytdlpPath, pre: [] },
      existsSync(venv) && { cmd: venv, pre: [] },
      { cmd: 'yt-dlp', pre: [] },
      { cmd: isWin ? 'python' : 'python3', pre: ['-m', 'yt_dlp'] },
    ].filter(Boolean);
    for (const c of candidates) {
      const version = await probe(c.cmd, [...c.pre, '--version']);
      if (version) return { ...c, version };
    }
    return null;
  })();
  return ytdlpPromise;
}

let ffmpegPromise;
/**
 * 运行 ffmpeg（转封装 / 转码）。失败时抛出带 stderr 末行的错误。
 */
export async function runFfmpeg(args, { signal } = {}) {
  const ffmpeg = await detectFfmpeg();
  if (!ffmpeg) throw new SourceError('NOT_INSTALLED', 'ffmpeg 未安装');
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr = (stderr + c).slice(-4000)));
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => reject(new SourceError('NOT_INSTALLED', `无法启动 ffmpeg: ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      code === 0 ? resolve() : reject(new SourceError('UPSTREAM', `ffmpeg 失败：${stderr.trim().split(/\r?\n/).pop() || code}`));
    });
  });
}

/** @returns {Promise<string | null>} ffmpeg 可执行文件路径 */
export function detectFfmpeg() {
  ffmpegPromise ??= (async () => {
    for (const cmd of [config.ffmpegPath, 'ffmpeg'].filter(Boolean)) {
      if (await probe(cmd, ['-version'])) return cmd;
    }
    return null;
  })();
  return ffmpegPromise;
}

function killTree(child) {
  if (child.exitCode !== null) return;
  // pip 安装的 yt-dlp.exe 是启动器，真正干活的是子 python 进程，必须杀整棵树
  if (isWin) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else child.kill('SIGKILL');
}

/** yt-dlp stderr → 错误分类 */
export function classifyYtdlpError(stderr) {
  const line = stderr.split(/\r?\n/).filter((l) => l.startsWith('ERROR')).pop() || stderr.trim().split(/\r?\n/).pop() || 'yt-dlp 失败';
  if (/HTTP Error (403|412|429)|Sign in to confirm|captcha|rate.?limit/i.test(stderr)) {
    return new SourceError('BLOCKED', `平台风控/限流：${line.slice(0, 200)}`);
  }
  if (/Private video|Video unavailable|not available|members-only|premium/i.test(stderr)) {
    return new SourceError('UNAVAILABLE', line.slice(0, 200));
  }
  return new SourceError('UPSTREAM', line.slice(0, 200));
}

/**
 * 运行 yt-dlp，逐行回调 stdout。始终 resolve（含非 0 退出码），由调用方决定如何处理。
 * signal 中止时杀掉进程树，已经产出的行依然有效。
 */
/** 各平台调用 yt-dlp 时的网络参数：YouTube 走代理 + 可选 Cookie；B 站默认直连 */
export function ytdlpNetArgs(platform) {
  const c = platform === 'bilibili' ? config.bilibili : config.youtube;
  return [
    ...(c.proxy ? ['--proxy', c.proxy] : []),
    ...(platform !== 'bilibili' && c.cookieFile && existsSync(c.cookieFile) ? ['--cookies', c.cookieFile] : []),
  ];
}

export async function runYtdlp(args, { signal, onLine } = {}) {
  const bin = await detectYtdlp();
  if (!bin) throw new SourceError('NOT_INSTALLED', 'yt-dlp 未安装（npm run setup:ytdlp）');
  const proxyAt = args.indexOf('--proxy');
  if (proxyAt >= 0) await assertProxyUp(args[proxyAt + 1]);
  const ffmpeg = await detectFfmpeg();

  const fullArgs = [
    ...bin.pre,
    '--ignore-config',
    '--no-warnings',
    '--encoding', 'utf-8',
    ...config.ytdlpJsRuntimes.flatMap((r) => ['--js-runtimes', r]),
    // 超时与重试：单次 socket 15s 无响应即重连，避免一个卡住的连接拖死整个任务
    '--socket-timeout', '15',
    '--retries', '3',
    '--fragment-retries', '3',
    '--extractor-retries', '2',
    ...(ffmpeg && ffmpeg !== 'ffmpeg' ? ['--ffmpeg-location', ffmpeg] : []),
    ...args,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(bin.cmd, fullArgs, {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let buf = '';
    let stderr = '';
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine?.(line);
      }
    });
    // 进度行在 quiet 模式下可能走 stderr，所以 stderr 也逐行回调一次
    let errBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      if (stderr.length < 20000) stderr += c;
      errBuf += c;
      let nl;
      while ((nl = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, nl).trim();
        errBuf = errBuf.slice(nl + 1);
        if (line.startsWith('HH')) onLine?.(line);
      }
    });
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new SourceError('NOT_INSTALLED', `无法启动 yt-dlp: ${e.message}`));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (buf.trim()) onLine?.(buf.trim());
      resolve({ code, stderr, aborted: !!signal?.aborted });
    });
  });
}
