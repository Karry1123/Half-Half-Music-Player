// downloads/library.json：已下载曲目的元数据索引（播放器可直接读取，无需再解析音频标签）
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.downloadDir, 'library.json');
let entries = [];
let writing = Promise.resolve();

export async function loadLibrary() {
  await mkdir(config.downloadDir, { recursive: true });
  try {
    entries = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    entries = [];
  }
}

/** 只返回磁盘上仍存在的文件 */
export function listLibrary() {
  return entries.filter((e) => existsSync(path.join(config.downloadDir, e.file)));
}

export function findInLibrary(trackId) {
  return listLibrary().find((e) => e.trackId === trackId) || null;
}

export function addToLibrary(entry) {
  entries = entries.filter((e) => e.trackId !== entry.trackId);
  entries.unshift(entry);
  // 串行 + 先写临时文件再 rename，避免并发下载同时完成时写坏 JSON
  writing = writing.then(async () => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(entries, null, 2));
    await rename(tmp, file);
  });
  return writing;
}
