// 断点续传 / 多地址切换 / 卡死检测：用一个故意出错的本地 HTTP 服务验证
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { config } from '../src/config.js';
import { parseLink } from '../src/lib/links.js';
import { downloadToFile, sortCdnUrls } from '../src/lib/transfer.js';
import { parseCookieText } from '../src/providers/bilibili.js';

const DATA = randomBytes(300_000);
let server;
let base;
const hits = { drop: 0, stall: 0, ranges: [] };

before(async () => {
  config.transfer.stallTimeoutMs = 300;
  server = http.createServer((req, res) => {
    const m = req.headers.range?.match(/bytes=(\d+)-/);
    const start = m ? Number(m[1]) : 0;
    hits.ranges.push(`${req.url}:${start}`);
    const send = (from, to) => {
      res.writeHead(m ? 206 : 200, {
        'Content-Length': DATA.length - from,
        ...(m ? { 'Content-Range': `bytes ${from}-${DATA.length - 1}/${DATA.length}` } : {}),
      });
      res.write(DATA.subarray(from, to));
    };
    if (req.url === '/forbidden') return res.writeHead(403).end();
    if (req.url === '/ok') return send(start, DATA.length), res.end();
    if (req.url === '/drop') {
      // 第一次只发 1/3 就断开，之后正常
      if (hits.drop++ === 0) return send(start, 100_000), setTimeout(() => res.destroy(), 50);
      return send(start, DATA.length), res.end();
    }
    if (req.url === '/stall') {
      // 第一次发一半后不再发送也不关闭（假死），之后正常
      if (hits.stall++ === 0) return send(start, 150_000);
      return send(start, DATA.length), res.end();
    }
    if (req.url === '/norange') {
      // 忽略 Range、总是从头返回 200
      res.writeHead(200, { 'Content-Length': DATA.length });
      if (hits.norange === undefined) {
        hits.norange = 1;
        res.write(DATA.subarray(0, 50_000));
        return setTimeout(() => res.destroy(), 50);
      }
      return res.end(DATA);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const dest = path.join(os.tmpdir(), `hh-transfer-${process.pid}.bin`);
async function fetchTo(urls) {
  const progress = [];
  await downloadToFile({ urls, dest, onProgress: (b) => progress.push(b) });
  const got = await readFile(dest);
  await rm(dest, { force: true });
  return { got, progress };
}

test('连接中途断开 → 从断点续传', async () => {
  const { got } = await fetchTo([`${base}/drop`]);
  assert.ok(got.equals(DATA));
  assert.ok(hits.ranges.some((r) => /^\/drop:(\d+)$/.test(r) && Number(r.split(':')[1]) > 0), '第二次请求应该带 Range');
});

test('连接假死 → 卡死超时后续传', async () => {
  const { got } = await fetchTo([`${base}/stall`]);
  assert.ok(got.equals(DATA));
});

test('403 地址 → 切换到备用地址', async () => {
  const { got } = await fetchTo([`${base}/forbidden`, `${base}/ok`]);
  assert.ok(got.equals(DATA));
});

test('服务器不支持 Range → 从头重下，文件不重复拼接', async () => {
  const { got } = await fetchTo([`${base}/norange`]);
  assert.equal(got.length, DATA.length);
  assert.ok(got.equals(DATA));
});

test('全部地址失效 → 抛出 BLOCKED', async () => {
  await assert.rejects(downloadToFile({ urls: [`${base}/forbidden`], dest }), (e) => e.code === 'BLOCKED');
  await rm(dest, { force: true });
});

test('PCDN 地址排到官方 CDN 之后', () => {
  const urls = ['https://xy1x2x3x4xy.mcdn.bilivideo.cn/a', 'https://upos-sz-mirrorcos.bilivideo.com/a', 'https://1.2.3.4:8082/a'];
  assert.equal(sortCdnUrls(urls)[0], 'https://upos-sz-mirrorcos.bilivideo.com/a');
});

test('链接解析（离线部分）', async () => {
  assert.deepEqual(await parseLink('https://www.bilibili.com/video/BV1mL411E7Fb/?p=3&spm=1'), { platform: 'bilibili', bvid: 'BV1mL411E7Fb', p: 3 });
  assert.deepEqual(await parseLink('av170001'), { platform: 'bilibili', aid: '170001', p: 1 });
  assert.deepEqual(await parseLink('https://youtu.be/cSqlwNjq77c?si=abc'), { platform: 'youtube', id: 'cSqlwNjq77c' });
  assert.deepEqual(await parseLink('https://music.youtube.com/watch?v=cSqlwNjq77c&list=RD'), { platform: 'ytmusic', id: 'cSqlwNjq77c' });
  await assert.rejects(parseLink('https://evil.example/BV1mL411E7Fb'), (e) => e.code === 'BAD_INPUT');
  await assert.rejects(parseLink('https://www.youtube.com/playlist?list=PL1'), (e) => e.code === 'BAD_INPUT');
});

test('Cookie 文件三种格式', () => {
  const netscape = '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tabc%2C1\n.other.com\tTRUE\t/\tFALSE\t0\tX\ty\n';
  assert.equal(parseCookieText(netscape).get('SESSDATA'), 'abc%2C1');
  assert.equal(parseCookieText(netscape).has('X'), false);
  const json = JSON.stringify([{ name: 'SESSDATA', value: 'j', domain: '.bilibili.com' }, { name: 'bili_jct', value: 'k', domain: '.bilibili.com' }]);
  assert.equal(parseCookieText(json).get('bili_jct'), 'k');
  assert.equal(parseCookieText('SESSDATA=s; bili_jct=t').get('SESSDATA'), 's');
});
