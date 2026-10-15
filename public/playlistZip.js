import JSZip from 'jszip';
import { fileNameOf } from './libraryStorageWeb.js';
export async function createPlaylistZip({ name, tracks, getBlob, onProgress = () => {} }) {
  if (!tracks.length) throw new Error('请至少选择一首歌曲');
  if (tracks.reduce((n, t) => n + (t.size || 0), 0) > 512 * 1024 * 1024) throw new Error('本次导出超过 512 MB，请分批勾选');
  const zip = new JSZip(), metadata = [], names = new Set(['metadata.json']);
  let next = 0, completed = 0, bytes = 0;
  await Promise.all(Array.from({ length: Math.min(3, tracks.length) }, async () => {
    while (next < tracks.length) {
      const index = next++, track = tracks[index], blob = await getBlob(track.id);
      if (!blob) throw new Error(`《${track.title}》未缓存，请先下载至本地`);
      bytes += blob.size;
      if (bytes > 512 * 1024 * 1024) throw new Error('本次导出超过 512 MB，请分批勾选');
      const base = fileNameOf({ ...track, title: track.title || '未命名', ext: /^[a-z0-9]{1,8}$/i.test(track.ext || '') ? track.ext : 'm4a' }); let filename = base, suffix = 2;
      while (names.has(filename.toLowerCase())) filename = base.replace(/(\.[^.]+)$/, ` (${suffix++})$1`);
      names.add(filename.toLowerCase());
      zip.file(filename, await blob.arrayBuffer());
      metadata[index] = { filename, title: track.title, artist: track.artist, duration: track.duration, sourceId: track.sourceId, pageUrl: track.pageUrl, hash: track.hash };
      onProgress({ done: ++completed, total: tracks.length, percent: 0 });
    }
  }));
  zip.file('metadata.json', JSON.stringify({ schemaVersion: 1, name, tracks: metadata }, null, 2));
  return zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' }, p => onProgress({ done: tracks.length, total: tracks.length, percent: p.percent }));
}
export async function saveZip(blob, name, storage) {
  const fileName = `${String(name || '歌单').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.zip`;
  // Android WebView ignores <a download>; hand the file to the system open-with / share sheet instead.
  if (storage?.exportBlob) return storage.exportBlob(blob, fileName, 'application/zip');
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
