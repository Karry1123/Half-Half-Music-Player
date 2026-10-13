// 网络模拟（测试用）：通过 URL 参数注入延迟、抖动和带宽限制，在本机就能复现弱网下的同步与缓冲行为。
//
//   ?netsim=delay:150,jitter:100,rate:300k
//     delay   控制消息额外单向延迟（ms）
//     jitter  额外随机延迟 0~jitter（ms），时钟同步与心跳会因此产生测量噪声
//     rate    文件传输带宽上限（字节/秒，支持 k / m 后缀）；Host 端设置才生效
//
// 只影响本端"发出"的数据：想模拟双向弱网，两个窗口都加上参数。
// DevTools 的 Network 限速对 WebRTC DataChannel 无效，所以需要这个。
export function parseNetsim(search) {
  const raw = new URLSearchParams(search).get('netsim');
  if (!raw) return null;
  const out = { delay: 0, jitter: 0, rate: 0 };
  for (const part of raw.split(',')) {
    const [k, v] = part.split(':').map((s) => s.trim().toLowerCase());
    if (!(k in out) || !v) continue;
    const m = v.match(/^([\d.]+)([km]?)$/);
    if (!m) continue;
    out[k] = Number(m[1]) * (k === 'rate' ? { '': 1, k: 1024, m: 1024 * 1024 }[m[2]] : 1);
  }
  return out;
}
