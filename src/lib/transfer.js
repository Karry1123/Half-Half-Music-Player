// 文件分片传输（DataChannel，可靠 + 有序）。
//
// 帧格式（同一条 'file' 通道上）：
//   string  {"type":"file_meta","id","name","size","mime"}
//   binary  ArrayBuffer 分片 × N（按序到达，无需序号）
//   string  {"type":"file_end","id"}
//
// 发送方用 bufferedAmount 做背压，避免把整首歌一次性塞进发送缓冲区
// （否则会占满内存，并且让同一 SCTP 连接上的 ctrl 消息排队变慢）。

const READ_BLOCK = 1 << 20; // 每次从磁盘读 1 MB
const HIGH_WATER = 1 << 20; // 发送缓冲超过 1 MB 就暂停
const LOW_WATER = 256 << 10; // 降到 256 KB 再继续

function waitDrain(ch) {
  return new Promise((resolve) => {
    const done = () => {
      ch.removeEventListener('bufferedamountlow', done);
      ch.removeEventListener('close', done);
      resolve();
    };
    ch.addEventListener('bufferedamountlow', done);
    ch.addEventListener('close', done);
  });
}

/**
 * @param {RTCDataChannel} ch
 * @param {File} file
 * @returns {Promise<boolean>} false 表示被取消（例如切歌）
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {number} [opts.rateLimit] 字节/秒，测试用：模拟慢速网络（见 netsim）
 */
export async function sendFile(ch, file, id, { chunkSize = 64 << 10, onProgress, isCancelled, rateLimit } = {}) {
  ch.bufferedAmountLowThreshold = LOW_WATER;
  ch.send(JSON.stringify({ type: 'file_meta', id, name: file.name, size: file.size, mime: file.type }));

  for (let off = 0; off < file.size; ) {
    const block = await file.slice(off, off + READ_BLOCK).arrayBuffer();
    for (let i = 0; i < block.byteLength; i += chunkSize) {
      if (ch.bufferedAmount > HIGH_WATER) await waitDrain(ch);
      if (isCancelled?.()) return false;
      if (ch.readyState !== 'open') throw new Error('数据通道已关闭');
      const chunk = block.slice(i, i + chunkSize);
      ch.send(chunk);
      if (rateLimit) {
        await sleep((chunk.byteLength / rateLimit) * 1000);
        onProgress?.(off + i + chunk.byteLength, file.size);
      }
    }
    off += block.byteLength;
    onProgress?.(off, file.size);
  }

  ch.send(JSON.stringify({ type: 'file_end', id }));
  return true;
}

export class FileReceiver {
  /** onChunk(meta, chunk)：每个分片到达时回调，用于边收边播 */
  constructor({ onMeta, onChunk, onProgress, onComplete }) {
    Object.assign(this, { onMeta, onChunk, onProgress, onComplete });
    this.meta = null;
    this.chunks = [];
    this.received = 0;
  }

  handle(data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.type === 'file_meta') {
        // 新文件会覆盖未完成的旧文件（发送方切歌时会中断旧传输）
        this.meta = msg;
        this.chunks = [];
        this.received = 0;
        this.onMeta?.(msg);
      } else if (msg.type === 'file_end' && msg.id === this.meta?.id) {
        const blob = new Blob(this.chunks, { type: this.meta.mime });
        const meta = this.meta;
        this.chunks = [];
        this.meta = null;
        this.onComplete?.(meta, blob);
      }
      return;
    }
    if (!this.meta) return;
    this.chunks.push(data);
    this.received += data.byteLength;
    this.onChunk?.(this.meta, data);
    this.onProgress?.(this.received, this.meta.size);
  }
}
