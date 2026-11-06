import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeLyrics, createLyricsClient, lyricsKey } from '../music-service/src/lyrics.js';
const response=(body,status=200)=>({ok:status===200,status,json:async()=>body});
test('LRCLIB response shaping keeps only lyric strings and attributes actual matches', () => {
 assert.deepEqual(shapeLyrics({syncedLyrics:' [00:01]Hello ',plainLyrics:'Hello',id:10}),{synced:'[00:01]Hello',plain:'Hello',source:'lrclib'});
 for(const record of [null,{}, {instrumental:true,plainLyrics:'wrong'},{syncedLyrics:3,plainLyrics:' '}]) assert.deepEqual(shapeLyrics(record),{synced:null,plain:null});
});
test('structured get uses signature, shared 8s signal and descriptive identity; fallback rejects unrelated matches', async () => {
 const calls=[];
 const client=createLyricsClient({fetchImpl:async(url,opts)=>{calls.push([new URL(url),opts]);return calls.length===1?response(null,404):response([
 {trackName:'Other',artistName:'Artist',syncedLyrics:'wrong'},
 {trackName:'Song',artistName:'Artist',duration:200,plainLyrics:'wrong version'},
 {trackName:'Song',artistName:'Artist',duration:121,syncedLyrics:'[00:01]Correct'}]);}});
 assert.deepEqual(await client({title:'Song',artist:'Artist',album:'Album',duration:120}),{synced:'[00:01]Correct',plain:null,source:'lrclib'});
 assert.equal(calls[0][0].pathname,'/api/get'); assert.equal(calls[0][0].searchParams.get('track_name'),'Song'); assert.equal(calls[0][0].searchParams.get('album_name'),'Album');
 assert.equal(calls[1][0].searchParams.get('q'),'Song Artist'); assert.equal(calls[0][1].signal,calls[1][1].signal); assert.match(calls[0][1].headers['User-Agent'],/HalfAndHalf.*https:/);
});
test('free-text lookups use search and cache no matches with normalized keys, TTL and LRU', async () => {
 let time=0, requests=0;
 const client=createLyricsClient({now:()=>time,capacity:2,fetchImpl:async(url)=>{requests++;assert.equal(new URL(url).pathname,'/api/search');return response([]);}});
 assert.deepEqual(await client({q:' Ｓong  Artist '}),{synced:null,plain:null});
 await client({q:'song artist'}); assert.equal(requests,1);
 await client({q:'b'}); await client({q:'song artist'}); await client({q:'c'}); await client({q:'b'}); assert.equal(requests,4);
 time=86400001; await client({q:'b'}); assert.equal(requests,5);
 assert.equal(lyricsKey({title:' Song ',artist:'ARTIST',duration:100}),lyricsKey({title:'song',artist:'artist',duration:100}));
});
test('concurrent identical queries share one request; failures do not become cached no-result', async () => {
 let resolve, requests=0;
 const client=createLyricsClient({fetchImpl:()=>{requests++;return new Promise(r=>resolve=r);}});
 const a=client({q:'Song'}), b=client({q:'Song'}); resolve(response([{plainLyrics:'Hello'}])); await Promise.all([a,b]); assert.equal(requests,1);
 let calls=0;const failing=createLyricsClient({fetchImpl:async()=>{calls++;return calls===1?response({},500):response([]);}});
 await assert.rejects(failing({q:'Song'})); await failing({q:'Song'}); assert.equal(calls,2);
});

test('search fallback accepts up to 15 seconds difference and still chooses the closest match', async () => {
 for (const delta of [-15, 15, -15.01, 15.01]) {
  const client=createLyricsClient({fetchImpl:async url => new URL(url).pathname.endsWith('/get') ? response(null,404) : response([{trackName:'Song',artistName:'Artist',duration:120+delta,plainLyrics:'Matched'}])});
  const result=await client({title:'Song',artist:'Artist',duration:120});
  assert.equal(result.plain,Math.abs(delta)<=15?'Matched':null);
 }
 const client=createLyricsClient({fetchImpl:async url => new URL(url).pathname.endsWith('/get') ? response(null,404) : response([
  {trackName:'Song',artistName:'Artist',duration:135,plainLyrics:'Farther'},
  {trackName:'Song',artistName:'Artist',duration:132,plainLyrics:'Closest'},
 ])});
 assert.equal((await client({title:'Song',artist:'Artist',duration:120})).plain,'Closest');
});
