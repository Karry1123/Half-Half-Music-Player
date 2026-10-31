// 读取音频文件内嵌的标签：标题 / 歌手 / 专辑 / 封面
// 纯 JS、无依赖，浏览器和 Node 都能跑。支持 MP4/M4A（ilst）、ID3v2（MP3 等）、FLAC（Vorbis comment + PICTURE）。
// 只读需要的字节：MP4 逐个 atom 定位 moov，ID3 只读标签区，FLAC 只读元数据块，不会把整首歌读进内存。

const MAX_COVER = 5 * 1024 * 1024;

/**
 * @param {Blob} file
 * @returns {Promise<{title: string|null, artist: string|null, album: string|null, cover: Blob|null}>}
 */
export async function readAudioTags(file) {
  const empty = { title: null, artist: null, album: null, cover: null };
  if (!file || typeof file.slice !== 'function' || file.size < 12) return empty;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  let tags = empty;
  if (ascii(head, 0, 3) === 'ID3') tags = await readId3(file, head);
  else if (ascii(head, 0, 4) === 'fLaC') tags = await readFlac(file);
  else if (ascii(head, 4, 8) === 'ftyp') tags = await readMp4(file);
  return clean(tags);
}

function clean(t) {
  const text = (s) => (typeof s === 'string' && s.trim() ? s.trim().replace(/\0+$/, '').trim() || null : null);
  const cover = t.cover && t.cover.size > 0 && t.cover.size <= MAX_COVER ? t.cover : null;
  return { title: text(t.title), artist: text(t.artist), album: text(t.album), cover };
}

const ascii = (u8, from, to) => String.fromCharCode(...u8.subarray(from, to));
const u32 = (u8, at) => ((u8[at] << 24) | (u8[at + 1] << 16) | (u8[at + 2] << 8) | u8[at + 3]) >>> 0;
const u24 = (u8, at) => (u8[at] << 16) | (u8[at + 1] << 8) | u8[at + 2];
const syncsafe = (u8, at) => (u8[at] << 21) | (u8[at + 1] << 14) | (u8[at + 2] << 7) | u8[at + 3];
const utf8 = (u8) => new TextDecoder('utf-8').decode(u8);
function imageBlob(bytes, mime) {
  const type = /^image\//.test(mime || '') ? mime : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : 'image/jpeg';
  return new Blob([bytes], { type });
}

// ───────────────────────── MP4 / M4A
// moov > udta > meta(版本 4 字节) > ilst > ©nam / ©ART / ©alb / covr > data(类型 4 字节 + locale 4 字节 + 内容)

async function readMp4(file) {
  let at = 0;
  while (at + 8 <= file.size) {
    const h = new Uint8Array(await file.slice(at, at + 16).arrayBuffer());
    let size = u32(h, 0);
    const type = ascii(h, 4, 8);
    let header = 8;
    if (size === 1) { size = Number((BigInt(u32(h, 8)) << 32n) | BigInt(u32(h, 12))); header = 16; }
    else if (size === 0) size = file.size - at;
    if (size < header) break;
    if (type === 'moov') {
      const moov = new Uint8Array(await file.slice(at + header, at + size).arrayBuffer());
      const udta = findAtom(moov, 0, moov.length, 'udta');
      const meta = udta && findAtom(moov, udta.start, udta.end, 'meta');
      const ilst = meta && findAtom(moov, meta.start + 4, meta.end, 'ilst');
      return ilst ? parseIlst(moov, ilst.start, ilst.end) : { title: null, artist: null, album: null, cover: null };
    }
    at += size;
  }
  return { title: null, artist: null, album: null, cover: null };
}

function findAtom(u8, from, to, name) {
  let at = from;
  while (at + 8 <= to) {
    const size = u32(u8, at);
    if (size < 8) return null;
    if (ascii(u8, at + 4, at + 8) === name) return { start: at + 8, end: Math.min(to, at + size) };
    at += size;
  }
  return null;
}

function parseIlst(u8, from, to) {
  const out = { title: null, artist: null, album: null, cover: null };
  const keys = { '\xa9nam': 'title', '\xa9ART': 'artist', aART: 'artist', '\xa9alb': 'album', covr: 'cover' };
  let at = from;
  while (at + 8 <= to) {
    const size = u32(u8, at);
    if (size < 8) break;
    const key = keys[ascii(u8, at + 4, at + 8)];
    const data = key && findAtom(u8, at + 8, at + size, 'data');
    if (data && data.end - data.start > 8) {
      const kind = u32(u8, data.start);
      const payload = u8.subarray(data.start + 8, data.end);
      if (key === 'cover') { if (!out.cover) out.cover = imageBlob(payload, kind === 14 ? 'image/png' : 'image/jpeg'); }
      else if (kind === 1 && (key !== 'artist' || !out.artist)) out[key] = utf8(payload);
    }
    at += size;
  }
  return out;
}

// ───────────────────────── ID3v2（v2.2 / v2.3 / v2.4）

async function readId3(file, head) {
  const out = { title: null, artist: null, album: null, cover: null };
  const version = head[3];
  const flags = head[5];
  const size = syncsafe(head, 6);
  const u8 = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
  let at = 0;
  if (version >= 3 && flags & 0x40) at += version === 4 ? syncsafe(u8, 0) : u32(u8, 0) + 4; // 扩展头
  const v2 = version === 2;
  const names = v2
    ? { TT2: 'title', TP1: 'artist', TAL: 'album', PIC: 'cover' }
    : { TIT2: 'title', TPE1: 'artist', TALB: 'album', APIC: 'cover' };
  while (at + (v2 ? 6 : 10) <= u8.length) {
    const id = ascii(u8, at, at + (v2 ? 3 : 4));
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    const len = v2 ? u24(u8, at + 3) : version === 4 ? syncsafe(u8, at + 4) : u32(u8, at + 4);
    const bodyAt = at + (v2 ? 6 : 10);
    const body = u8.subarray(bodyAt, bodyAt + len);
    const key = names[id];
    if (key === 'cover' && !out.cover) out.cover = parseApic(body, v2);
    else if (key && key !== 'cover' && !out[key]) out[key] = decodeText(body[0], body.subarray(1));
    at = bodyAt + len;
  }
  return out;
}

function decodeText(encoding, bytes) {
  if (encoding === 1 || encoding === 2) {
    const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : encoding === 2 || (bytes[0] === 0xfe && bytes[1] === 0xff) ? 'utf-16be' : 'utf-16le';
    const start = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff) ? 2 : 0;
    return new TextDecoder(bom).decode(bytes.subarray(start));
  }
  return new TextDecoder(encoding === 0 ? 'latin1' : 'utf-8').decode(bytes);
}

function parseApic(body, v2) {
  const encoding = body[0];
  let at = 1;
  let mime;
  if (v2) { mime = `image/${ascii(body, 1, 4).toLowerCase()}`; at = 4; }
  else { const end = body.indexOf(0, at); mime = utf8(body.subarray(at, end)); at = end + 1; }
  at += 1; // picture type
  const wide = encoding === 1 || encoding === 2;
  if (wide) { while (at + 1 < body.length && !(body[at] === 0 && body[at + 1] === 0)) at += 2; at += 2; }
  else { at = body.indexOf(0, at) + 1; }
  if (at <= 0 || at >= body.length) return null;
  return imageBlob(body.subarray(at), mime === 'image/jpg' ? 'image/jpeg' : mime);
}

// ───────────────────────── FLAC

async function readFlac(file) {
  const out = { title: null, artist: null, album: null, cover: null };
  let at = 4;
  for (;;) {
    if (at + 4 > file.size) break;
    const h = new Uint8Array(await file.slice(at, at + 4).arrayBuffer());
    const last = !!(h[0] & 0x80);
    const type = h[0] & 0x7f;
    const len = u24(h, 1);
    if (type === 4 || type === 6) {
      const body = new Uint8Array(await file.slice(at + 4, at + 4 + len).arrayBuffer());
      if (type === 4) parseVorbisComment(body, out);
      else if (!out.cover) out.cover = parseFlacPicture(body);
    }
    at += 4 + len;
    if (last) break;
  }
  return out;
}

function parseVorbisComment(u8, out) {
  const le32 = (at) => (u8[at] | (u8[at + 1] << 8) | (u8[at + 2] << 16) | (u8[at + 3] << 24)) >>> 0;
  let at = 4 + le32(0);
  const count = le32(at);
  at += 4;
  for (let i = 0; i < count && at + 4 <= u8.length; i++) {
    const len = le32(at);
    const entry = utf8(u8.subarray(at + 4, at + 4 + len));
    at += 4 + len;
    const eq = entry.indexOf('=');
    const key = entry.slice(0, eq).toUpperCase();
    const value = entry.slice(eq + 1);
    if (key === 'TITLE' && !out.title) out.title = value;
    else if (key === 'ARTIST' && !out.artist) out.artist = value;
    else if (key === 'ALBUM' && !out.album) out.album = value;
  }
}

function parseFlacPicture(u8) {
  let at = 4; // picture type
  const mimeLen = u32(u8, at); at += 4;
  const mime = ascii(u8, at, at + mimeLen); at += mimeLen;
  const descLen = u32(u8, at); at += 4 + descLen;
  at += 16; // width, height, depth, colors
  const dataLen = u32(u8, at); at += 4;
  return imageBlob(u8.subarray(at, at + dataLen), mime);
}
