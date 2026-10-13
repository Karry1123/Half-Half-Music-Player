// 本地 TURN 中继（开发 / 局域网测试用），由 scripts/dev-all.mjs 启动。
//
// 为什么局域网也需要它：
//   电脑连手机热点、或 Wi-Fi 开了设备隔离时，浏览器常常拿不到可直连的局域网候选
//   （Chrome 用 mDNS 隐藏本机 IP，手机解析不了；手机做热点时 WebRTC 只看得到 4G 网卡），
//   打洞又要经过运营商 NAT 的"回环"，几乎都会失败。
//   但只要手机能打开 http://电脑IP:8080，就一定能连到电脑上的 TURN —— 中继路径总是可用。
//
// node-turn 在未指定 relayIps 时，会在"客户端连进来的那个地址"上分配中继端口，
// 所以手机经 172.20.10.x 连入就在 172.20.10.x 上中继，天然适配多网卡。
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import os from 'node:os';

const require = createRequire(import.meta.url);

export const TURN_PORT = Number(process.env.TURN_PORT) || 3478;

/** 可被局域网其他设备访问的 IPv4（排除 169.254.x.x 这类未分配地址） */
export function lanAddresses() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) list.push({ name, address: a.address });
    }
  }
  return list;
}

export function udpPortFree(port) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => resolve(false));
    s.bind(port, () => s.close(() => resolve(true)));
  });
}

/**
 * 启动 TURN，返回浏览器要用的 ICE 配置。
 * @returns {{ iceServers: RTCIceServer[], urls: string[], stop: () => void }}
 */
export function startLocalTurn({ port = TURN_PORT, stun = [] } = {}) {
  const Turn = require('node-turn');
  const username = 'halfhalf';
  const credential = randomBytes(9).toString('base64url'); // 每次启动随机，只在本机信令里下发
  const server = new Turn({
    listeningPort: port,
    authMech: 'long-term',
    credentials: { [username]: credential },
    realm: 'halfhalf.local',
    minPort: 49160,
    maxPort: 49400,
    debugLevel: 'ERROR',
  });
  server.start();
  const urls = lanAddresses().flatMap(({ address }) => [`turn:${address}:${port}?transport=udp`]);
  return {
    urls,
    iceServers: [...(stun.length ? [{ urls: stun }] : []), { urls, username, credential }],
    stop: () => server.stop(),
  };
}
