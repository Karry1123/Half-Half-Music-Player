// 根据文件头判断音频格式，以及能否用 MediaSource Extensions（MSE）边收边播。
//
// MSE 能播的：
//   MP3                 audio/mpeg（Chrome / Edge / Safari / Firefox 均支持）
//   fragmented MP4      audio/mp4; codecs="mp4a.40.x"  ← B 站 / YouTube 的 DASH 音轨就是这种
//   WebM                audio/webm; codecs="opus"
// MSE 不能播的（只能收完再解码）：
//   普通 MP4（moov 无 mvex，或 moov 在文件末尾）、FLAC、WAV、OGG
//
// 纯函数，不依赖 DOM（isTypeSupported 由调用方传入），方便单元测试。

const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/** 在 [start, end) 范围内遍历 MP4 box */
function* boxes(b, start, end) {
  let i = start;
  while (i + 8 <= end) {
    let size = u32(b, i);
    const type = ascii(b, i + 4, 4);
    let header = 8;
    if (size === 1) {
      if (i + 16 > end) return;
      size = Number((BigInt(u32(b, i + 8)) << 32n) | BigInt(u32(b, i + 12)));
      header = 16;
    } else if (size === 0) size = end - i;
    if (size < header) return;
    yield { type, start: i, body: i + header, end: Math.min(i + size, end), complete: i + size <= end };
    i += size;
  }
}

const find = (b, start, end, type) => {
  for (const box of boxes(b, start, end)) if (box.type === type) return box;
  return null;
};

/** 从 esds 的 DecoderSpecificInfo 读取 AAC 的 audioObjectType：2 = AAC-LC，5 = HE-AAC，29 = HE-AACv2 */
function aacObjectType(b, start, end) {
  for (let i = start; i < end - 2; i++) {
    if (b[i] !== 0x05) continue; // DecSpecificInfoTag
    let j = i + 1;
    let len = 0;
    for (let k = 0; k < 4 && j < end; k++, j++) {
      len = (len << 7) | (b[j] & 0x7f);
      if (!(b[j] & 0x80)) {
        j++;
        break;
      }
    }
    if (len < 1 || j >= end) continue;
    let aot = b[j] >> 3;
    if (aot === 31 && j + 1 < end) aot = 32 + (((b[j] & 0x07) << 3) | (b[j + 1] >> 5));
    if (aot > 0 && aot < 64) return aot;
  }
  return 2;
}

function sniffMp4(b) {
  const end = b.length;
  const moov = find(b, 0, end, 'moov');
  if (!moov || !moov.complete) return { container: 'mp4', mime: null, reason: 'moov 不在文件开头（非流式 MP4）' };
  const fragmented = !!find(b, moov.body, moov.end, 'mvex');
  // 粗略定位音频采样描述：直接在 moov 里搜索 sample entry 的四字符码
  const text = ascii(b, moov.body, moov.end - moov.body);
  let codecs;
  if (text.includes('mp4a')) {
    const esds = text.indexOf('esds');
    codecs = `mp4a.40.${esds >= 0 ? aacObjectType(b, moov.body + esds, moov.end) : 2}`;
  } else if (text.includes('Opus')) codecs = 'opus';
  else if (text.includes('fLaC')) codecs = 'flac';
  else if (text.includes('ac-3')) codecs = 'ac-3';
  if (!codecs) return { container: 'mp4', mime: null, reason: '未识别的音频编码' };
  const mime = `audio/mp4; codecs="${codecs}"`;
  return fragmented ? { container: 'fmp4', mime } : { container: 'mp4', mime: null, reason: '非分片 MP4（需完整接收）', codecs };
}

/**
 * @param {Uint8Array} head 文件开头若干字节（建议 ≥ 64KB，确保包含完整 moov）
 * @param {(mime: string) => boolean} [isTypeSupported] 通常传 MediaSource.isTypeSupported
 * @returns {{ container: string, mime: string|null, streamable: boolean, reason?: string }}
 */
export function sniffAudio(head, isTypeSupported = () => false) {
  const b = head;
  let r;
  if (b.length < 12) r = { container: 'unknown', mime: null, reason: '数据太少' };
  else if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) r = { container: 'mp3', mime: 'audio/mpeg' };
  else if (ascii(b, 4, 4) === 'ftyp') r = sniffMp4(b);
  else if (u32(b, 0) === 0x1a45dfa3) r = { container: 'webm', mime: 'audio/webm; codecs="opus"' };
  else if (ascii(b, 0, 4) === 'fLaC') r = { container: 'flac', mime: null, reason: 'FLAC 不支持 MSE 流式播放' };
  else if (ascii(b, 0, 4) === 'OggS') r = { container: 'ogg', mime: null, reason: 'Ogg 不支持 MSE 流式播放' };
  else if (ascii(b, 0, 4) === 'RIFF') r = { container: 'wav', mime: null, reason: 'WAV 不支持 MSE 流式播放' };
  else r = { container: 'unknown', mime: null, reason: '未知格式' };

  const supported = !!r.mime && isTypeSupported(r.mime);
  if (r.mime && !supported) r.reason = `浏览器不支持 MSE 类型 ${r.mime}`;
  return { ...r, streamable: supported };
}
