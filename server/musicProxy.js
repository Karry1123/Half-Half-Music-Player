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

/** Forward the dashboard's backend sockets alongside its HTTP API requests. */
export function attachMusicUpgrade(server, backend = MUSIC_SERVICE_URL) {
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!pathname.startsWith('/music-api/')) return;
    if (!isLoopback(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const target = new URL(req.url.replace(/^\/music-api/, ''), backend);
    const upstream = http.request(target, { headers: { ...req.headers, host: target.host } });
    const fail = () => { upstream.destroy(); socket.destroy(); };
    socket.on('error', fail);
    upstream.on('error', fail);
    socket.on('close', () => upstream.destroy());
    upstream.on('response', response => {
      socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
      response.resume();
    });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
      for (let i = 0; i < response.rawHeaders.length; i += 2) socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
      socket.write('\r\n');
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.on('error', () => socket.destroy());
      socket.on('close', () => remote.destroy());
      remote.pipe(socket); socket.pipe(remote);
    });
    upstream.end();
  });
}
