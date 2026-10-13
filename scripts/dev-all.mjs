// 一键启动本地联调环境：npm run dev:all
//
//   1. 环境自检：Node 版本、依赖（缺失自动 npm install）、yt-dlp
//   2. 端口检查：8080 / 8090 被旧进程占用时给出 PID；加 --kill-stale 自动结束
//   3. 同时启动 music-service 与 Vite（前缀区分日志），Ctrl+C 一起退出
//   4. 打印测试链接 + 手机扫码二维码
//
// 参数：
//   --kill-stale        结束占用端口的旧进程
//   --no-music          不启动 music-service（只测同步播放）
//   --netsim=SPEC       在打印的测试链接里附带网络模拟参数，如 delay:150,jitter:100,rate:300k
//   --no-turn           不启动本地 TURN 中继（默认启动，解决手机热点 / 设备隔离下 P2P 连不上）
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { DEFAULT_STUN, describeTurn } from '../server/ice.js';
import { lanAddresses, startLocalTurn, TURN_PORT, udpPortFree } from '../server/turn.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = new Set(process.argv.slice(2).filter((a) => !a.startsWith('--netsim=')));
const netsim = process.argv.find((a) => a.startsWith('--netsim='))?.slice(9);
const isWin = process.platform === 'win32';
const WEB_PORT = 8080;
const MUSIC_PORT = 8090;

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const [bold, dim, green, yellow, red, cyan, magenta] = [1, 2, 32, 33, 31, 36, 35].map(c);
const ok = (s) => console.log(`  ${green('✓')} ${s}`);
const warn = (s) => console.log(`  ${yellow('!')} ${s}`);
const fail = (s) => console.log(`  ${red('✗')} ${s}`);

// ───────────────────────────── 1. 环境自检
console.log(bold('\nHalf&Half 本地联调\n'));
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  fail(`Node ${process.versions.node}，需要 ≥ 20`);
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

function ensureDeps(dir, label) {
  if (existsSync(path.join(dir, 'node_modules'))) return ok(`${label} 依赖已安装`);
  warn(`${label} 缺少依赖，正在 npm install…`);
  // 路径含 & 时 npm.cmd 会出问题，直接用 node 执行 npm-cli.js
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  execFileSync(process.execPath, [npmCli, 'install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
}
ensureDeps(root, '前端');
const musicDir = path.join(root, 'music-service');
const withMusic = !args.has('--no-music');
if (withMusic) {
  ensureDeps(musicDir, 'music-service');
  const venv = path.join(musicDir, '.venv', isWin ? 'Scripts/yt-dlp.exe' : 'bin/yt-dlp');
  if (existsSync(venv)) ok('yt-dlp 已安装');
  else warn('yt-dlp 未安装：搜索下载不可用（cd music-service && npm run setup:ytdlp）');
}

// ───────────────────────────── 2. 端口
/** 先尝试连接：music-service 只监听 127.0.0.1，Windows 上再绑 0.0.0.0 也会"成功"，单靠 listen 检测会误判 */
function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.setTimeout(500, () => (s.destroy(), resolve(false)));
  });
}

async function portFree(port) {
  if (await portInUse(port)) return false;
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });
}

function pidsOn(port) {
  try {
    if (isWin) {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
      return [...new Set(out.split('\n').filter((l) => l.includes(`:${port} `) && /LISTENING/.test(l)).map((l) => l.trim().split(/\s+/).pop()))];
    }
    return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function kill(pid) {
  try {
    if (isWin) execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
    else process.kill(Number(pid), 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

for (const [port, label] of [[WEB_PORT, '页面/信令'], ...(withMusic ? [[MUSIC_PORT, 'music-service']] : [])]) {
  if (await portFree(port)) {
    ok(`端口 ${port}（${label}）空闲`);
    continue;
  }
  const pids = pidsOn(port);
  if (args.has('--kill-stale') && pids.length) {
    pids.forEach(kill);
    await new Promise((r) => setTimeout(r, 500));
    if (await portFree(port)) {
      ok(`端口 ${port} 已释放（结束了 PID ${pids.join(', ')}）`);
      continue;
    }
  }
  fail(`端口 ${port}（${label}）被占用${pids.length ? `：PID ${pids.join(', ')}` : ''}`);
  console.log(dim(`    多半是上次没关掉的服务。重新运行并加 --kill-stale 自动结束：npm run dev:all -- --kill-stale`));
  process.exit(1);
}

// ───────────────────────────── 3. 本地 TURN 中继
let turn = null;
if (!args.has('--no-turn') && !process.env.ICE_SERVERS) {
  if (await udpPortFree(TURN_PORT)) {
    turn = startLocalTurn({ stun: DEFAULT_STUN });
    ok(`本地 TURN 中继 UDP ${TURN_PORT}（${turn.urls.map((u) => u.replace(/^turn:|\?.*$/g, '')).join('、') || '无局域网地址'}）`);
  } else warn(`UDP ${TURN_PORT} 被占用，跳过本地 TURN（局域网 P2P 可能连不上）`);
}

const remoteTurn = describeTurn();
if (remoteTurn.length) ok(`公网 TURN：${remoteTurn.join('、')}（跨网络 / 跨境连接用）`);
else warn('未配置公网 TURN：不同网络（尤其跨境、4G）的设备可能连不上，配置方法见 TESTING.md「跨网络 / 跨境连接」');

// ───────────────────────────── 4. 启动
const children = [];
function run(name, color, cmd, cmdArgs, cwd, readyRe, onReady) {
  const env = { ...process.env, FORCE_COLOR: '1', ...(turn && { ICE_SERVERS: JSON.stringify(turn.iceServers) }) };
  const child = spawn(cmd, cmdArgs, { cwd, env, windowsHide: true });
  children.push(child);
  let ready = false;
  const prefix = color(`[${name}]`.padEnd(8));
  const onData = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      console.log(`${prefix} ${line}`);
      if (!ready && readyRe.test(line.replace(/\x1b\[[0-9;]*m/g, ''))) {
        ready = true;
        onReady?.();
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    console.log(`${prefix} ${code === 0 ? '已退出' : red(`异常退出 (${code})`)}`);
    shutdown(code ?? 1);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  turn?.stop();
  for (const ch of children) if (ch.exitCode === null) (isWin ? kill(String(ch.pid)) : ch.kill('SIGTERM'));
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('');
if (withMusic) run('music', magenta, process.execPath, ['src/server.js'], musicDir, /music-service:/);
run('web', cyan, process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(WEB_PORT), '--strictPort'], root, /Local:/, printGuide);

// ───────────────────────────── 5. 测试指引

function printGuide() {
  const q = (extra) => {
    const p = new URLSearchParams(extra);
    if (netsim) p.set('netsim', netsim);
    p.set('debug', '1');
    return `?${p}`;
  };
  const lan = lanAddresses();
  console.log(`\n${bold('────────────── 测试链接 ──────────────')}`);
  console.log(`${bold('Host（本机）')}     http://localhost:${WEB_PORT}/${q({ name: 'Host' })}`);
  console.log(`${bold('Guest（本机）')}    http://localhost:${WEB_PORT}/${q({ name: 'Guest' })}`);
  console.log(dim('                 建议用另一个浏览器或无痕窗口打开 Guest，避免两个标签页互相节流'));
  if (lan.length) {
    const url = `http://${lan[0].address}:${WEB_PORT}/${q({ name: 'Phone' })}`;
    console.log(`${bold('Guest（手机）')}    ${url}`);
    for (const a of lan.slice(1)) console.log(dim(`                 也可试 http://${a.address}:${WEB_PORT}/（${a.name}）`));
    qrcode.generate(url, { small: true }, (code) => console.log(code.replace(/^/gm, '    ')));
    console.log(dim('    手机与电脑须在同一网络；Windows 防火墙弹窗请允许 Node.js（含 UDP，TURN 中继要用）'));
    if (turn) console.log(dim('    连不上时在链接后加 &relay=1 强制走本地 TURN，可判断是不是防火墙问题'));
  }
  console.log(dim('\n  测试步骤见 TESTING.md · 单元测试 npm test · NAT 自检 npm run nat-check · Ctrl+C 全部退出\n'));
}
