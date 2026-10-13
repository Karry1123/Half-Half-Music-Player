// NAT / STUN 自检：npm run nat-check
//
// 1. 逐个探测 STUN 服务器是否可达、延迟多少（决定 ICE 配置里放哪些）
// 2. 用"同一个 UDP 端口"分别询问两台 STUN 服务器自己的公网映射地址：
//      两次映射的端口相同 → 端点无关映射（锥形 NAT），跨网 P2P 打洞大概率成功
//      端口不同           → 对称 NAT，跨网 P2P 基本只能走 TURN 中继
// 局域网内两台设备直连不经过 NAT，不受此结果影响。
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { DEFAULT_STUN } from '../server/ice.js';

const EXTRA = ['stun.l.google.com:19302', 'stun.cloudflare.com:3478', 'stun.miwifi.com:3478', 'stun.chat.bilibili.com:3478', 'stun.nextcloud.com:443'];
const servers = [...new Set([...DEFAULT_STUN.map((u) => u.replace(/^stun:/, '')), ...EXTRA])];

function bindingRequest(sock, hostport, timeout = 3000) {
  const [host, port] = hostport.split(':');
  return new Promise(async (resolve) => {
    let ip;
    try {
      ip = (await dns.lookup(host, { family: 4 })).address;
    } catch {
      return resolve({ hostport, error: 'DNS 解析失败' });
    }
    const tid = randomBytes(12);
    const t0 = performance.now();
    const onMsg = (msg, rinfo) => {
      if (rinfo.address !== ip || !msg.subarray(8, 20).equals(tid)) return;
      cleanup();
      resolve({ hostport, ip, ms: Math.round(performance.now() - t0), mapped: parseMapped(msg) });
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ hostport, ip, error: `超时 ${timeout / 1000}s` });
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      sock.off('message', onMsg);
    };
    sock.on('message', onMsg);
    sock.send(Buffer.concat([Buffer.from([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]), tid]), Number(port), ip);
  });
}

function parseMapped(msg) {
  for (let i = 20; i + 4 <= msg.length; ) {
    const type = msg.readUInt16BE(i);
    const len = msg.readUInt16BE(i + 2);
    if (type === 0x0020 && msg[i + 5] === 1) {
      const port = msg.readUInt16BE(i + 6) ^ 0x2112;
      const addr = [...msg.subarray(i + 8, i + 12)].map((b, k) => b ^ [0x21, 0x12, 0xa4, 0x42][k]).join('.');
      return { addr, port };
    }
    i += 4 + len + ((4 - (len % 4)) % 4);
  }
  return null;
}

function newSocket() {
  const s = dgram.createSocket('udp4');
  return new Promise((r) => s.bind(0, () => r(s)));
}

console.log('① STUN 服务器可达性\n');
const reach = await Promise.all(
  servers.map(async (hp) => {
    const s = await newSocket();
    const r = await bindingRequest(s, hp);
    s.close();
    return r;
  }),
);
for (const r of reach) console.log(r.error ? `  ✗ ${r.hostport.padEnd(28)} ${r.error}` : `  ✓ ${r.hostport.padEnd(28)} ${String(r.ms).padStart(4)} ms`);

const ok = reach.filter((r) => !r.error && r.mapped);
console.log('\n② NAT 映射行为（同一本地端口 → 两台服务器）\n');
if (ok.length < 2) {
  console.log('  可达的 STUN 服务器不足两台，无法判断。跨网使用请配置 TURN（见 TESTING.md）');
} else {
  const sock = await newSocket();
  const localPort = sock.address().port;
  const a = await bindingRequest(sock, ok[0].hostport);
  const b = await bindingRequest(sock, ok[1].hostport);
  sock.close();
  console.log(`  本地端口 ${localPort}`);
  console.log(`  ${a.hostport.padEnd(28)} → ${a.mapped?.addr}:${a.mapped?.port}`);
  console.log(`  ${b.hostport.padEnd(28)} → ${b.mapped?.addr}:${b.mapped?.port}`);
  if (!a.mapped || !b.mapped) console.log('\n  结果不完整，请重试');
  else if (a.mapped.port === b.mapped.port && a.mapped.addr === b.mapped.addr)
    console.log('\n  ✓ 端点无关映射（锥形 NAT / 公网 IP）：跨网 P2P 打洞通常可以成功');
  else console.log('\n  ⚠ 对称 NAT：跨网 P2P 很可能失败，需要 TURN 中继（ICE_SERVERS 环境变量，见 TESTING.md）');
}
console.log('\n局域网内两台设备直连不经过 NAT，不受上面结果影响。');
