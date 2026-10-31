import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAudioTags } from '../public/audioTags.js';

const enc = new TextEncoder();
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const bytes = (...parts) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...enc.encode(p)] : [...p])));
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9];

// MP4 atom: 4 字节大小 + 4 字节类型 + 内容
// ilst 的 key 以 0xA9（©）开头，是单个原始字节，不是 UTF-8 的两个字节
const atom = (type, ...body) => { const b = bytes(...body); return bytes(be32(8 + b.length), type.startsWith('©') ? bytes([0xa9], type.slice(1)) : type, b); };
const ilstItem = (key, kind, payload) => atom(key, atom('data', be32(kind), be32(0), payload));

test('MP4：从 moov/udta/meta/ilst 读出标题、歌手和 covr 封面', async () => {
  const ilst = atom('ilst',
    ilstItem('\xa9nam', 1, enc.encode('Hong Kong (feat. 王菲季候風)')),
    ilstItem('\xa9ART', 1, enc.encode('The Weeknd')),
    ilstItem('\xa9alb', 1, enc.encode('Hong Kong')),
    ilstItem('covr', 13, JPEG));
  const moov = atom('moov', atom('mvhd', new Uint8Array(20)), atom('udta', atom('meta', be32(0), atom('hdlr', new Uint8Array(4)), ilst)));
  const file = new Blob([atom('ftyp', 'M4A '), atom('free', new Uint8Array(3)), moov, atom('mdat', new Uint8Array(50))]);
  const t = await readAudioTags(file);
  assert.equal(t.title, 'Hong Kong (feat. 王菲季候風)');
  assert.equal(t.artist, 'The Weeknd');
  assert.equal(t.album, 'Hong Kong');
  assert.equal(t.cover.type, 'image/jpeg');
  assert.equal(t.cover.size, JPEG.length);
});

test('MP4：moov 在文件末尾（没有 faststart）也能找到', async () => {
  const ilst = atom('ilst', ilstItem('\xa9nam', 1, enc.encode('Late moov')), ilstItem('covr', 14, PNG));
  const moov = atom('moov', atom('udta', atom('meta', be32(0), ilst)));
  const t = await readAudioTags(new Blob([atom('ftyp', 'isom'), atom('mdat', new Uint8Array(4000)), moov]));
  assert.equal(t.title, 'Late moov');
  assert.equal(t.cover.type, 'image/png');
});

// ID3v2.3 帧：4 字节 id + 4 字节大小 + 2 字节 flags
const frame = (id, ...body) => { const b = bytes(...body); return bytes(id, be32(b.length), [0, 0], b); };
const syncsafe = (n) => [(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127];
const id3 = (version, ...frames) => { const b = bytes(...frames); return bytes('ID3', [version, 0, 0], syncsafe(b.length + 20), b, new Uint8Array(20)); };

test('ID3v2.3：TIT2 / TPE1 文本（UTF-16 带 BOM）和 APIC 封面', async () => {
  const utf16 = (s) => [0xff, 0xfe, ...[...s].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])];
  const tag = id3(3,
    frame('TIT2', [1], utf16('歌名')),
    frame('TPE1', [0], enc.encode('Artist')),
    frame('APIC', [0], 'image/jpeg\0', [3], 'front\0', JPEG));
  const t = await readAudioTags(new Blob([tag, new Uint8Array(100)]));
  assert.equal(t.title, '歌名');
  assert.equal(t.artist, 'Artist');
  assert.equal(t.cover.type, 'image/jpeg');
  assert.equal(t.cover.size, JPEG.length);
});

test('ID3v2.4：帧大小是 syncsafe，图片 MIME 为 image/jpg 时归一化', async () => {
  const body = bytes([0], 'image/jpg\0', [3], '\0', JPEG);
  const tag = bytes('ID3', [4, 0, 0], syncsafe(10 + body.length), 'APIC', syncsafe(body.length), [0, 0], body);
  const t = await readAudioTags(new Blob([tag]));
  assert.equal(t.cover.type, 'image/jpeg');
  assert.equal(t.title, null);
});

test('FLAC：Vorbis comment 与 PICTURE 块', async () => {
  const comment = (s) => { const b = enc.encode(s); return bytes(le32(b.length), b); };
  const vorbis = bytes(le32(4), 'test', le32(2), comment('TITLE=Flac song'), comment('artist=Someone'));
  const picture = bytes(be32(3), be32(10), 'image/jpeg', be32(0), new Uint8Array(16), be32(JPEG.length), JPEG);
  const block = (type, body, last = false) => bytes([(last ? 0x80 : 0) | type], [(body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255], body);
  const file = new Blob([bytes('fLaC'), block(0, new Uint8Array(34)), block(4, vorbis), block(6, picture, true), new Uint8Array(30)]);
  const t = await readAudioTags(file);
  assert.equal(t.title, 'Flac song');
  assert.equal(t.artist, 'Someone');
  assert.equal(t.cover.size, JPEG.length);
});

test('无法识别的文件和过小的文件返回空标签，不抛错', async () => {
  assert.deepEqual(await readAudioTags(new Blob([new Uint8Array(200)])), { title: null, artist: null, album: null, cover: null });
  assert.deepEqual(await readAudioTags(new Blob([bytes('ID3')])), { title: null, artist: null, album: null, cover: null });
  assert.deepEqual(await readAudioTags(null), { title: null, artist: null, album: null, cover: null });
});
