// 本机导入的歌自动上传到账号云端，其他设备就能在歌单里直接下载（服务端：music-service/src/trackFiles.js）。
// 没有本地状态：每次运行都问服务器哪些指纹还没有，把缺的按顺序传上去；传失败的指纹本次会话里不再重试。
import { checkCloudFiles, uploadLocalFile } from './accountClient.js';

/** 需要上传的歌：本地导入（没有平台音源）、有指纹、文件在本机 */
export const needsUpload = (t) => !!t && !t.sourceId && !!t.hash && t.source !== 'youtube' && t.source !== 'ytmusic' && t.source !== 'bilibili';

/**
 * @param {{ client: import('./accountClient.js').AccountClient, storage: { listTracks(): Promise<object[]>, getBlob(id: string): Promise<Blob|null> },
 *           onProgress?: (info: { track: object, progress: number }) => void, notify?: (message: string, level?: string) => void, fileNameOf?: (t: object) => string }} deps
 */
export function createCloudUploader({ client, storage, onProgress = () => {}, notify = () => {}, fileNameOf = (t) => t.fileName || '' }) {
  const failed = new Map(); // hash → 错误信息
  let running = null, again = false;

  async function once() {
    const tracks = (await storage.listTracks()).filter(needsUpload);
    if (!tracks.length) return { uploaded: 0, skipped: 0 };
    const { present, used, quota, maxFile } = await checkCloudFiles(client, [...new Set(tracks.map((t) => t.hash))].slice(0, 500));
    const have = new Set(present);
    let uploaded = 0, skipped = 0, quotaHit = false;
    for (const t of tracks) {
      if (have.has(t.hash) || failed.has(t.hash)) continue;
      if (!client.user?.isActivated) break;
      try {
        const blob = await storage.getBlob(t.id);
        if (!blob) { failed.set(t.hash, '本机没有这首歌的文件'); skipped++; continue; }
        if (blob.size > maxFile) { failed.set(t.hash, `超过单文件上限 ${Math.round(maxFile / 1048576)} MB`); skipped++; continue; }
        if (used + blob.size > quota) { failed.set(t.hash, '云端空间不足'); skipped++; quotaHit = true; continue; }
        const r = await uploadLocalFile(client, blob, { hash: t.hash, fileName: fileNameOf(t), mime: blob.type }, (progress) => onProgress({ track: t, progress }));
        have.add(t.hash);
        if (!r.skipped) uploaded++;
      } catch (e) {
        failed.set(t.hash, e.message);
        skipped++;
        if (e.code === 'QUOTA') quotaHit = true;
        if (e.status === 401 || e.status === 403) break; // 登录失效：下次同步再试
      }
    }
    if (uploaded) notify(`已把 ${uploaded} 首本机导入的歌上传到云端，其他设备可以直接下载`);
    if (quotaHit) notify('云端空间不足，部分本机导入的歌没有上传', 'warn');
    return { uploaded, skipped };
  }

  return {
    get enabled() { return !!(client.required && client.user?.isActivated); },
    failures() { return new Map(failed); },
    /** 并发调用只跑一个；运行中再被调用则结束后再跑一轮 */
    run() {
      if (!this.enabled) return Promise.resolve(null);
      if (running) { again = true; return running; }
      running = (async () => {
        try {
          let result;
          do { again = false; result = await once(); } while (again);
          return result;
        } finally { running = null; }
      })();
      return running;
    },
  };
}
