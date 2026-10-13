// 在 music-service/.venv 中安装/升级 yt-dlp。
// 自动选择本机最新的 Python（yt-dlp 已弃用 3.10 及以下）。
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const venv = path.join(root, '.venv');
const isWin = process.platform === 'win32';

const candidates = isWin
  ? [['py', ['-3.13']], ['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3']], ['python', []]]
  : [['python3.13', []], ['python3.12', []], ['python3.11', []], ['python3', []], ['python', []]];

function version(cmd, pre) {
  try {
    const out = execFileSync(cmd, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const [major, minor] = out.toString().trim().split('.').map(Number);
    return { major, minor };
  } catch {
    return null;
  }
}

let best = null;
for (const [cmd, pre] of candidates) {
  const v = version(cmd, pre);
  if (v && v.major === 3 && (!best || v.minor > best.v.minor)) best = { cmd, pre, v };
}
if (!best || best.v.minor < 10) {
  console.error('未找到 Python 3.10+，请先安装 https://www.python.org/downloads/');
  process.exit(1);
}
console.log(`使用 Python ${best.v.major}.${best.v.minor} (${[best.cmd, ...best.pre].join(' ')})`);
if (best.v.minor < 11) console.warn('提示：yt-dlp 已弃用 Python 3.10，建议安装 3.11+');

const venvPython = path.join(venv, isWin ? 'Scripts/python.exe' : 'bin/python');
const current = existsSync(venvPython) && version(venvPython, []);
if (current && current.minor !== best.v.minor) {
  console.log(`现有 .venv 是 Python 3.${current.minor}，重建`);
  rmSync(venv, { recursive: true, force: true });
}
if (!existsSync(venvPython)) execFileSync(best.cmd, [...best.pre, '-m', 'venv', venv], { stdio: 'inherit' });
execFileSync(venvPython, ['-m', 'pip', 'install', '-U', '--disable-pip-version-check', 'yt-dlp'], { stdio: 'inherit' });
console.log('yt-dlp 版本:', execFileSync(venvPython, ['-m', 'yt_dlp', '--version']).toString().trim());
