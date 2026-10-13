import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sniffAudio } from '../src/lib/sniff.js';

const all = () => true;
const box = (type, ...children) => {
  const body = Buffer.concat(children.map((c) => (typeof c === 'string' ? Buffer.from(c, 'latin1') : c)));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
// esds 里的 DecoderSpecificInfo（tag 0x05），首字节高 5 位是 audioObjectType
const esds = (aot) => box('esds', Buffer.from([0, 0, 0, 0, 0x03, 0x19, 0, 1, 0, 0x04, 0x11, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x02, aot << 3, 0x10]));
const mp4 = ({ fragmented, aot = 2 }) =>
  new Uint8Array(Buffer.concat([box('ftyp', 'dash', Buffer.alloc(4)), box('moov', box('mvhd', Buffer.alloc(20)), box('trak', box('mp4a', Buffer.alloc(28), esds(aot))), ...(fragmented ? [box('mvex', box('trex', Buffer.alloc(24)))] : [])), box('moof', Buffer.alloc(8))]));

test('MP3（ID3 头 / 帧同步头）可流式', () => {
  assert.deepEqual(sniffAudio(new Uint8Array([...Buffer.from('ID3'), 4, 0, 0, 0, 0, 0, 0, 0, 0]), all).mime, 'audio/mpeg');
  const r = sniffAudio(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]), all);
  assert.equal(r.container, 'mp3');
  assert.equal(r.streamable, true);
});

test('分片 MP4（DASH）可流式，并读出 AAC 类型', () => {
  const lc = sniffAudio(mp4({ fragmented: true }), all);
  assert.equal(lc.container, 'fmp4');
  assert.equal(lc.mime, 'audio/mp4; codecs="mp4a.40.2"');
  assert.equal(lc.streamable, true);
  assert.equal(sniffAudio(mp4({ fragmented: true, aot: 5 }), all).mime, 'audio/mp4; codecs="mp4a.40.5"');
});

test('普通 MP4 / FLAC / WAV 不可流式，回退到完整接收', () => {
  for (const [bytes, container] of [
    [mp4({ fragmented: false }), 'mp4'],
    [new Uint8Array([...Buffer.from('fLaC'), 0, 0, 0, 0x22, 0, 0, 0, 0]), 'flac'],
    [new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE')]), 'wav'],
  ]) {
    const r = sniffAudio(bytes, all);
    assert.equal(r.container, container);
    assert.equal(r.streamable, false);
    assert.ok(r.reason);
  }
});

test('moov 在文件末尾（只拿到文件头）时不可流式', () => {
  const head = new Uint8Array(Buffer.concat([box('ftyp', 'isom', Buffer.alloc(4)), box('mdat', Buffer.alloc(64))]));
  assert.equal(sniffAudio(head, all).streamable, false);
});

test('浏览器不支持该 MIME 时不可流式', () => {
  const r = sniffAudio(mp4({ fragmented: true }), () => false);
  assert.equal(r.streamable, false);
  assert.match(r.reason, /不支持/);
});
