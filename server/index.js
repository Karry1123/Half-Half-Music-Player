// 生产模式：托管 Vite 构建产物（dist/）+ 信令 + /music-api 代理。
// 开发模式不走这里，见 vite.config.js。
import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iceConfigAsync } from './ice.js'; // 先导入：它会加载项目根目录的 .env
import { proxyMusic, attachMusicUpgrade } from './musicProxy.js';
import { attachSignaling } from './signaling.js';
import { lanAddresses } from './turn.js';
import { authorizeRequest } from './accountAccess.js';

const PORT = Number(process.env.PORT) || 8080;
const DIST = normalize(fileURLToPath(new URL('../dist/', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('未找到 dist/，请先运行 npm run build（开发请用 npm run dev）');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/music-api/') || req.url === '/music-api') return proxyMusic(req, res);
  if (req.url === '/lan.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ips: lanAddresses().map((a) => a.address) }));
  }
  if (req.url === '/ice.json') {
    if (!(await authorizeRequest(req, res))) return;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return iceConfigAsync().then((list) => res.end(JSON.stringify(list)));
  }
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let filePath = normalize(join(DIST, urlPath));
    if (!filePath.startsWith(DIST)) return res.writeHead(403).end('Forbidden');
    if (!existsSync(filePath) || urlPath.endsWith('/')) filePath = join(DIST, 'index.html'); // SPA 回退
    const data = await readFile(filePath);
    const immutable = filePath.includes(`${join(DIST, 'assets')}`);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

attachSignaling(server);
attachMusicUpgrade(server);

server.listen(PORT, () => {
  console.log('Half&Half 已启动:');
  console.log(`  本机:   http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  局域网: http://${a.address}:${PORT}`);
    }
  }
});
