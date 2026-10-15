// ICE 服务器配置，由服务端下发给浏览器（/ice.json，以及自建信令的 created / joined 消息），
// 这样换 STUN / 配 TURN 只需改环境变量（或项目根目录的 .env），不用重新构建前端。
//
// 组成：基础列表（默认 STUN，或 ICE_SERVERS 整体替换） + 下面任意几种 TURN（可同时配置，依次追加）
//
//   ① 自建 coturn，固定账号        TURN_URL=turn:turn.example.com:3478  TURN_USER=u  TURN_PASS=p
//   ② 自建 coturn，临时凭证（推荐） TURN_URL=…  TURN_SECRET=<coturn 的 static-auth-secret>
//        coturn 配置 use-auth-secret + static-auth-secret；这里按 TURN REST API 规范签发 24 小时有效的
//        用户名 / 密码，泄露了也会自动过期，比固定账号安全
//   ③ Metered（有免费额度）         METERED_DOMAIN=yourapp.metered.live  METERED_API_KEY=…
//   ④ Cloudflare TURN（有免费额度） CLOUDFLARE_TURN_KEY_ID=…  CLOUDFLARE_TURN_API_TOKEN=…
//        ③④ 的 API Key / Token 只在服务端使用，浏览器只拿到短期凭证；结果缓存，过期前自动刷新
//
//   ICE_SERVERS='[{"urls":"stun:…"}]'  整体替换基础列表（JSON，与 RTCIceServer 格式一致）；
//   scripts/dev-all.mjs 用它注入本机 TURN 中继。上面配置的 TURN 仍会追加在后面。
//
// 跨境 / 对称 NAT（4G、公司网、校园网）基本只能靠 TURN 中继：两端都连得上的那台 TURN 服务器决定成败，
// 所以 TURN 最好放在双方都低延迟可达的地区（例如中国大陆 ↔ 海外，选香港 / 新加坡 / 东京）。
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTurnEnabled } from './turnQuota.js';

// 项目根目录的 .env（可选）。已有的环境变量优先
const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// 默认 STUN 同时照顾海外与国内网络（2026-10 实测均可达）；浏览器建议总数不超过 4 个，过多会拖慢收集。
export const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.miwifi.com:3478', // 小米，国内可达
  'stun:stun.chat.bilibili.com:3478', // B 站，国内可达
];

const CRED_TTL = 24 * 3600; // 签发的临时凭证有效期（秒）
const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

/** TURN REST API（coturn use-auth-secret）：username = 过期时间戳:标识，password = base64(HMAC-SHA1(secret, username)) */
export function turnRestCredential(secret, ttl = CRED_TTL, id = 'halfhalf') {
  const username = `${Math.floor(Date.now() / 1000) + ttl}:${id}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

// ───────────────────────────── 需要调 API 的 TURN（Metered / Cloudflare），缓存 + 后台刷新

const dynamic = { servers: [], cloudflare: [], expiresAt: 0, refreshing: null, error: null };
const dynamicServers = () => [...(cloudflareTurnEnabled() ? dynamic.cloudflare : []), ...dynamic.servers];

async function fetchMetered(env) {
  const r = await fetch(`https://${env.METERED_DOMAIN.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`Metered HTTP ${r.status}`);
  const servers = await r.json();
  if (!Array.isArray(servers)) throw new Error('Metered 返回格式不对');
  // Metered 自带一个 STUN，我们已经有了，只要 TURN
  return servers.filter((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));
}

async function fetchCloudflare(env) {
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: CRED_TTL }),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`Cloudflare HTTP ${r.status}`);
  const j = await r.json();
  const servers = j.iceServers ? [].concat(j.iceServers) : [];
  return servers
    .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => /^turns?:/.test(u) && !/:53\b/.test(u)) })) // 53 端口被很多浏览器屏蔽
    .filter((s) => s.urls.length);
}

/** 刷新 Metered / Cloudflare 凭证；失败时保留上一次的结果 */
export function refreshDynamicTurn(env = process.env) {
  const wantMetered = env.METERED_DOMAIN && env.METERED_API_KEY;
  const wantCf = cloudflareTurnEnabled() && env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN;
  if (!wantMetered && !wantCf) return Promise.resolve(dynamicServers());
  if (Date.now() < dynamic.expiresAt - 3600_000) return Promise.resolve(dynamicServers()); // 过期前 1 小时刷新
  dynamic.refreshing ??= (async () => {
    const jobs = [wantMetered && fetchMetered(env).then(servers => { dynamic.servers = servers; return servers; }), wantCf && fetchCloudflare(env).then(servers => { dynamic.cloudflare = servers; return servers; })].filter(Boolean);
    const results = await Promise.allSettled(jobs);
    const ok = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
    const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
    if (errors.length) console.warn(`[ice] TURN 凭证获取失败：${errors.join('；')}`);
    if (ok.length) {
      dynamic.expiresAt = Date.now() + CRED_TTL * 1000;
    } else dynamic.expiresAt = Date.now() + 3600_000 + 60_000; // 全部失败：1 分钟后再试
    dynamic.error = errors[0] || null;
    return dynamicServers();
  })().finally(() => (dynamic.refreshing = null));
  return dynamic.refreshing;
}

/**
 * 同步版：直接用缓存的 Metered / Cloudflare 凭证（第一次调用时在后台开始获取）。
 * 需要保证拿到最新凭证时用 iceConfigAsync()。
 */
export function iceConfig(env = process.env) {
  let base = [{ urls: DEFAULT_STUN }];
  if (env.ICE_SERVERS) {
    try {
      const parsed = JSON.parse(env.ICE_SERVERS);
      if (Array.isArray(parsed) && parsed.length) base = parsed;
    } catch {
      console.warn('[ice] ICE_SERVERS 不是合法 JSON，使用默认配置');
    }
  }
  const turn = [];
  const urls = list(env.TURN_URL);
  if (urls.length) {
    if (env.TURN_SECRET) turn.push({ urls, ...turnRestCredential(env.TURN_SECRET) });
    else turn.push({ urls, username: env.TURN_USER, credential: env.TURN_PASS });
  }
  refreshDynamicTurn(env).catch(() => {});
  return [...dynamicServers(), ...base, ...turn];
}

export async function iceConfigAsync(env = process.env) {
  await refreshDynamicTurn(env).catch(() => {});
  return iceConfig(env);
}

/** 启动日志用：配置了哪些 TURN（不含凭证） */
export function describeTurn(env = process.env) {
  const out = [];
  if (env.TURN_URL) out.push(`coturn ${list(env.TURN_URL).join(' ')}${env.TURN_SECRET ? '（临时凭证）' : ''}`);
  if (env.METERED_DOMAIN && env.METERED_API_KEY) out.push(`Metered ${env.METERED_DOMAIN}`);
  if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) out.push('Cloudflare TURN');
  return out;
}
