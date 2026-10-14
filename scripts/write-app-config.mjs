// 构建后执行：按环境变量生成 dist/app-config.js，并为 GitHub Pages 生成 404.html（单页应用回退）。
//
//   MUSIC_API_URL  music-service 的公网地址，如 https://halfhalf-music.onrender.com
//   SIGNAL_URL     信令 WebSocket（默认 = MUSIC_API_URL 换成 wss://…/ws）
//   ICE_URL        ICE 配置（默认 = MUSIC_API_URL + /ice.json）
//
// GitHub Actions 里来自仓库 Variables（Settings → Secrets and variables → Actions → Variables），
// Vercel 里来自项目 Environment Variables。都不需要放访问令牌。
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!existsSync(dist)) {
  console.error('dist/ 不存在：先运行 vite build');
  process.exit(1);
}

const clean = (u) => (u || '').trim().replace(/\/+$/, '');
function checkUrl(name, value, protocols) {
  if (!value) return;
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} 不是合法 URL：${value}`);
  }
  if (!protocols.includes(u.protocol)) throw new Error(`${name} 必须以 ${protocols.join(' / ')} 开头：${value}`);
  // 页面是 https 的（Pages / Vercel），后端是 http 会被浏览器当成混合内容拦掉
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); // 本机预演不用提醒
  if ((u.protocol === 'http:' || u.protocol === 'ws:') && !local) console.warn(`⚠ ${name} 用的是不加密的 ${u.protocol}，https 页面会拦截它`);
}

const apiBase = clean(process.env.MUSIC_API_URL);
const signalUrl = clean(process.env.SIGNAL_URL) || (apiBase ? `${apiBase.replace(/^http/, 'ws')}/ws` : '');
const iceUrl = clean(process.env.ICE_URL) || (apiBase ? `${apiBase}/ice.json` : '');
checkUrl('MUSIC_API_URL', apiBase, ['https:', 'http:']);
checkUrl('SIGNAL_URL', signalUrl, ['wss:', 'ws:']);
checkUrl('ICE_URL', iceUrl, ['https:', 'http:']);

// Android app only: where the force-update check looks for releases ("owner/repo"), and optional download mirrors
// (comma-separated https:// prefixes such as https://ghfast.top/ ; only used when the APK's SHA-256 is known).
const updateRepo = (process.env.UPDATE_REPO || process.env.GITHUB_REPOSITORY || '').trim();
if (updateRepo && !/^[\w.-]+\/[\w.-]+$/.test(updateRepo)) throw new Error(`UPDATE_REPO 必须是 owner/repo 的形式：${updateRepo}`);
const updateMirrors = (process.env.UPDATE_MIRRORS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const m of updateMirrors) checkUrl('UPDATE_MIRRORS', m, ['https:']);

const cfg = Object.fromEntries(Object.entries({ apiBase, signalUrl, iceUrl, updateRepo, updateMirrors: updateMirrors.length ? updateMirrors : '' }).filter(([, v]) => v));
await writeFile(
  path.join(dist, 'app-config.js'),
  `// 由 scripts/write-app-config.mjs 在构建时生成，请勿手改\nwindow.HH_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`,
);

// GitHub Pages 没有服务端重写：找不到的路径会返回 404.html，让它和 index.html 一样即可进入单页应用
await copyFile(path.join(dist, 'index.html'), path.join(dist, '404.html'));

const html = await readFile(path.join(dist, 'index.html'), 'utf8');
console.log(`app-config.js：${Object.keys(cfg).length ? JSON.stringify(cfg) : '空（本地 / 同源模式）'}`);
console.log(`base：${html.match(/src="([^"]*assets\/[^"]+)"/)?.[1]?.replace(/assets\/.*/, '') || '/'}`);
if (!apiBase) console.warn('⚠ 没有设置 MUSIC_API_URL：线上页面只能用演示数据搜索（双人同步、本地导入仍可用）');
