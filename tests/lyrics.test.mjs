import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, currentLineIndex, lyricsQuery, createLyricsCache } from '../public/lyrics.js';
test('LRC supports sorted repeated timestamps, hundredths/milliseconds, blank cues and metadata', () => {
 const lines = parseLrc('[ti:Title]\n[ar:Artist]\n[offset:100]\n[01:02.345][00:02.50] Chorus\n[00:01.12] First\n[00:03]\n[00:99.00]bad\nplain text');
 assert.deepEqual(lines, [{time:1.12,text:'First'}, {time:2.5,text:'Chorus'}, {time:3,text:''}, {time:62.345,text:'Chorus'}]);
 assert.deepEqual(parseLrc(null), []); assert.deepEqual(parseLrc('[al:Album]'), []);
});
test('current line uses the final timestamp at or before position, including duplicates and seeks', () => {
 const lines = parseLrc('[00:01]a\n[00:02]b\n[00:02]c');
 assert.equal(currentLineIndex(lines, 0), -1); assert.equal(currentLineIndex(lines, 1), 0);
 assert.equal(currentLineIndex(lines, 2), 2); assert.equal(currentLineIndex(lines, 100), 2);
 assert.equal(currentLineIndex(lines, 1.5), 0); assert.equal(currentLineIndex([], 10), -1); assert.equal(currentLineIndex(lines, NaN), -1);
});
test('query strips video/demo suffixes and rejects imports without usable title/artist metadata', () => {
 assert.deepEqual(lyricsQuery({title:'Song（演示） (Official Video) [MV]',artist:'Artist',album:'Album',duration:120}), {title:'Song',artist:'Artist',album:'Album',duration:120});
 assert.equal(lyricsQuery({title:'recording',artist:'本地文件',source:'local'}), null);
 assert.equal(lyricsQuery({title:'untitled',artist:'Artist'}), null);
 assert.ok(lyricsQuery({title:'Song',source:'youtube'}));
 assert.equal(lyricsQuery({title:'Song',artist:'Artist'}, Infinity).duration, 0);
});
const storage = () => { const db = new Map(); return {db, getItem:k => db.get(k), setItem:(k,v) => db.set(k,v)}; };
test('track cache persists, expires, evicts least recently used, and supports explicit refresh', () => {
 let time=0; const store=storage(), cache=createLyricsCache({storage:store, now:()=>time, maxEntries:2});
 cache.set('a',{synced:'[00:01]a',plain:null,source:'lrclib'}); cache.set('b',{plain:'b'});
 assert.equal(createLyricsCache({storage:store,now:()=>time}).get('a').source,'lrclib');
 cache.set('c',{plain:'c'}); assert.equal(cache.get('b'),null); assert.equal(cache.get('a').synced,'[00:01]a');
 cache.remove('a'); assert.equal(cache.get('a'),null); time=86400001; assert.equal(cache.get('c'),null);
});
test('cache caps size and tolerates corrupt or inaccessible localStorage', () => {
 const store=storage(), cache=createLyricsCache({storage:store,maxChars:200});
 cache.set('a',{plain:'x'.repeat(1000)}); assert.ok(store.db.get('hh.lyrics.v1').length<=200); assert.equal(cache.get('a'),null);
 store.setItem('hh.lyrics.v1','invalid JSON'); assert.equal(cache.get('a'),null);
 const broken=createLyricsCache({storage:{getItem(){throw Error('blocked');},setItem(){throw Error('quota');}}});
 assert.doesNotThrow(()=>broken.set('a',{plain:'a'})); assert.equal(broken.get('a'),null);
});

test('per-track offsets persist, clamp to ±30s and survive lyric refresh/expiry', () => {
 let time=0; const store=storage(), cache=createLyricsCache({storage:store,now:()=>time});
 assert.equal(cache.getOffset('a'),0);
 cache.set('a',{plain:'Lyrics'});
 assert.equal(cache.setOffset('a',1.5),1.5);
 assert.equal(createLyricsCache({storage:store,now:()=>time}).getOffset('a'),1.5);
 assert.equal(cache.getOffset('b'),0);
 cache.remove('a'); assert.equal(cache.get('a'),null); assert.equal(cache.getOffset('a'),1.5);
 cache.set('a',{synced:'[00:01]Refetched'}); assert.equal(cache.getOffset('a'),1.5);
 time=86400001; assert.equal(cache.get('a'),null); assert.equal(cache.getOffset('a'),1.5);
 assert.equal(cache.setOffset('b',99),30); assert.equal(cache.setOffset('c',-99),-30);
 assert.equal(cache.getOffset('b'),30); assert.equal(cache.getOffset('c'),-30);
 assert.equal(cache.setOffset('a',0),0); assert.equal(cache.getOffset('a'),0);
 assert.equal(cache.setOffset('b',NaN),0); assert.equal(cache.setOffset('c',Infinity),0);
});
