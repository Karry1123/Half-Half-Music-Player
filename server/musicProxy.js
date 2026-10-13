// /music-api/* → music-service（默认 http://127.0.0.1:8090）
//
// music-service 会往 Host 磁盘写文件，所以只允许本机浏览器（Host）访问（含用本机网卡 IP 打开页面的情况）；
// 局域网里的 Guest 访问 /music-api 一律 403。SSE（/api/events）通过管道流式转发。
import http from 'node:http';
import os from 'node:os';

export const MUSIC_SERVICE_URL = process.env.MUSIC_SERVICE_URL || 'http://127.0.0.1:8090';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 本机自己的所有网卡地址（含 169.254.x.x、局域网 IP）：用这些地址打开页面的仍然是 Host 本机浏览器 */
function ownAddresses() {
  const set = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs ?? []) set.add(a.address);
  return set;
}

export const isLoopback = (req) => {
  const ra = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return LOOPBACK.has(req.socket.remoteAddress) || ownAddresses().has(ra);
};

export function proxyMusic(req, res) {
  if (!isLoopback(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '音乐服务只对 Host 本机开放' }));
    return;
  }
  const target = new URL(req.url.replace(/^\/music-api/, '') || '/', MUSIC_SERVICE_URL);
  const upstream = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '音乐服务未启动（cd music-service && npm start）' }));
  });
  req.on('close', () => upstream.destroy()); // 浏览器关闭 SSE 时断开上游
  req.pipe(upstream);
}
