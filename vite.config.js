import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { iceConfigAsync } from './server/ice.js';
import { attachSignaling } from './server/signaling.js';
import { lanAddresses } from './server/turn.js';
import { isLoopback, MUSIC_SERVICE_URL } from './server/musicProxy.js';

// 开发模式：一个端口搞定页面 + HMR + 信令（/ws）+ 音乐服务代理（/music-api）
const halfHalfDevServer = {
  name: 'half-half-dev-server',
  configureServer(server) {
    if (server.httpServer) attachSignaling(server.httpServer);
    // 单文件 Dashboard（PeerJS 版）从这里读取同一份 ICE 配置（含 dev:all 启动的本地 TURN）
    server.middlewares.use('/ice.json', async (_req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store'); // 含临时 TURN 凭证
      res.end(JSON.stringify(await iceConfigAsync()));
    });
    // 本机局域网 IP：页面在 localhost 打开时，二维码 / 邀请链接要换成手机能访问的地址
    server.middlewares.use('/lan.json', (_req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ips: lanAddresses().map((a) => a.address) }));
    });
    // 音乐服务只对 Host 本机开放（在 Vite 内置 proxy 之前拦截）
    server.middlewares.use('/music-api', (req, res, next) => {
      if (isLoopback(req)) return next();
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: '音乐服务只对 Host 本机开放' }));
    });
  },
};

export default defineConfig({
  // GitHub Pages 项目页在 https://<用户>.github.io/<仓库名>/ 下，构建时由工作流传入 VITE_BASE=/<仓库名>/
  base: process.env.VITE_BASE || '/',
  plugins: [react(), halfHalfDevServer],
  server: {
    host: true, // 局域网设备可访问
    port: 8080,
    proxy: {
      '/music-api': {
        target: MUSIC_SERVICE_URL,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/music-api/, ''),
      },
    },
  },
});
