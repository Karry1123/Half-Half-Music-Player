import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// music-service/.env（可选，格式见 .env.example）。已存在的环境变量优先，不会被覆盖
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const env = process.env;
/** 相对路径按 music-service 目录解析，方便在 .env 里写 COOKIE_PATH=./cookies/bilibili.txt */
const file = (p) => (p ? path.resolve(root, p) : null);
const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

export const config = {
  root,
  // 默认只监听本机：这个服务会往磁盘写文件，不应暴露到局域网。公网部署（Docker / Render）设 HOST=0.0.0.0
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT) || 8090, // Render 会注入 PORT
  // ── 公网部署安全项（见 src/lib/guard.js、DEPLOY.md）。本机运行时都不用设
  corsOrigins: list(env.CORS_ORIGINS || env.CORS_ORIGIN), // 空 = 允许任意来源（仅适合本机）
  apiToken: env.API_TOKEN || '',
  rateLimitPerMin: env.RATE_LIMIT != null ? Number(env.RATE_LIMIT) : 60, // 每 IP 每分钟搜索 / 解析 / 下载请求数，0 = 不限
  // 同时提供 WebRTC 信令（/ws）与 /ice.json：Vite 主应用部署在静态托管上时需要（复用项目根目录 server/ 下的实现）
  signaling: env.ENABLE_SIGNALING === '1',

  downloadDir: path.resolve(env.DOWNLOAD_DIR || path.join(root, 'downloads')),
  cacheDir: path.resolve(env.CACHE_DIR || path.join(root, '.cache')),
  maxConcurrentDownloads: Number(env.MAX_DOWNLOADS) || 2,

  // 外部工具：未设置时自动探测（.venv → PATH → python -m yt_dlp）
  ytdlpPath: file(env.YTDLP_PATH),
  // 新版 yt-dlp 解析 YouTube 需要 JS 运行时（默认只找 deno）；容器里已经有 node，设 YTDLP_JS_RUNTIMES=node 即可
  ytdlpJsRuntimes: list(env.YTDLP_JS_RUNTIMES),
  ffmpegPath: env.FFMPEG_PATH && /[\\/]/.test(env.FFMPEG_PATH) ? file(env.FFMPEG_PATH) : env.FFMPEG_PATH || null, // 带路径的才按相对路径解析
  youtube: {
    // 国内访问 YouTube 用的代理，yt-dlp 与 YouTube Music 搜索（fetch）都走它
    //   http://127.0.0.1:7890 · socks5://127.0.0.1:7890 · socks5h://user:pass@host:1080
    proxy: env.PROXY_URL || env.YT_PROXY || env.YTDLP_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY || null,
    // 可选：YouTube 登录 Cookie（Netscape cookies.txt），出现 "Sign in to confirm you're not a bot" 时配置
    cookieFile: file(env.YTDLP_COOKIES || env.YT_COOKIE_PATH) || (existsSync(path.join(root, 'cookies/youtube.txt')) ? path.join(root, 'cookies/youtube.txt') : null),
    intervalMs: Math.max(0, Number(env.YTDLP_MIN_INTERVAL_MS) || 1500),
    backoffMs: Math.max(0, Number(env.YTDLP_BACKOFF_MS) || 4000),
    clients: (env.YTDLP_PLAYER_CLIENTS || 'default;web_safari,mweb').split(';').map(s => s.trim()).filter(Boolean).slice(0, 3),
    poToken: env.YTDLP_PO_TOKEN || '',
    poProvider: env.YTDLP_PO_TOKEN_PROVIDER_URL || '',
  },

  bilibili: {
    // 可选：浏览器里复制的完整 Cookie（含 SESSDATA）。大会员账号可解析 Hi-Res 无损 / 杜比全景声音轨
    cookie: env.BILIBILI_COOKIE || '',
    // 或者指向 Cookie 文件：Netscape cookies.txt、浏览器插件导出的 JSON、或一行 "SESSDATA=…; bili_jct=…"
    // 文件修改后自动重新加载，无需重启
    cookieFile: file(env.COOKIE_PATH || env.BILIBILI_COOKIE_PATH),
    // B 站在国内直连即可；只有部署在海外时才需要（默认不走 PROXY_URL）
    proxy: env.BILIBILI_PROXY || null,
    // API 请求最小间隔（毫秒），避免短时间密集请求触发风控
    minIntervalMs: Number(env.BILI_MIN_INTERVAL) || 300,
    // 专门搬运/收藏原版音乐的 UP 主：打"收藏 UP"标记并加分
    trustedUploaders: list(env.BILI_TRUSTED_UPS || '音乐私藏馆,JLRS-LeoFM'),
  },

  search: {
    perSourceLimit: 10,
    timeoutMs: Number(env.SEARCH_TIMEOUT) || 8000, // HTTP 类音源
    ytdlpTimeoutMs: Number(env.YTDLP_SEARCH_TIMEOUT) || 15000, // yt-dlp 类音源（需要起进程）
    cacheTtlMs: 5 * 60 * 1000,
    maxDurationSec: 15 * 60, // 超过 15 分钟的视频基本是合集，不是单曲
  },

  resolve: {
    timeoutMs: Number(env.RESOLVE_TIMEOUT) || 30000, // yt-dlp 完整解析一条 YouTube 链接通常 3~8s
  },

  transfer: {
    connectTimeoutMs: 10000, // 等待 CDN 响应头
    stallTimeoutMs: Number(env.STALL_TIMEOUT) || 20000, // 连续这么久没收到数据视为卡死，断点续传重试
    maxRetries: 4, // 每个 CDN 地址的续传次数
  },
};
