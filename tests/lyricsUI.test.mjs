import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import React from 'react';
import htm from 'htm';
import { parseLrc, currentLineIndex, lyricsQuery } from '../public/lyrics.js';
const source = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
const between = (a,b) => source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const flatten = n => Array.isArray(n) ? n.flatMap(flatten) : n && typeof n === 'object' ? [n,...flatten(n.props?.children)] : [];
function sheetHarness({offset=0,position=10,role=null,data={synced:'[00:05]First\n[00:10]Second',plain:null},status='ready',cached=null,request=async()=>data,reduced=false,item={id:'song',title:'Song',artist:'Artist',duration:100}}={}) {
 const state={role,loaded:true,conn:'open',duration:100,playing:true}, key=JSON.stringify([item?.id,lyricsQuery(item,item?.duration||state.duration)]);
 const effects=[],changes=[],seeks=[],requests=[],cacheWrites=[],scrolls=[],offsetWrites=[];
 const slots=[{key,status,data,error:'服务暂时不可用'},'sync',0,{id:item?.localId || item?.id,value:offset}];
 let focused=0,returned=0;
 const old={isConnected:true,focus:()=>returned++}, row={offsetTop:180,offsetHeight:48};
 const node={style:{setProperty(){}},querySelector:selector=>selector.includes('button')?{focus:()=>focused++}:row,scrollTo:opts=>scrolls.push(opts),clientHeight:200};
 const Component=vm.runInNewContext(`${between('function LyricsSheet(', 'function PlayerQueueDrawer(')};LyricsSheet`,{
  useStore:fn=>fn(state),usePosition:()=>position,useState:()=>{const i=4-slots.length;return [slots.shift(),v=>changes.push([i,v])];},useRef:initial=>({current:initial===null?node:initial}),useEffect:fn=>effects.push(fn),useMemo:fn=>fn(),useBackLayer(){},
  ResizeObserver:class { observe(){} disconnect(){} }, document:{activeElement:old},window:{matchMedia:()=>({matches:reduced})},
  html:htm.bind(React.createElement),cx:(...args)=>args.filter(Boolean).join(' '),parseLrc,currentLineIndex,lyricsQuery,
  lyricsCache:{getOffset:()=>offset,setOffset:(id,value)=>{const clamped=Math.max(-30,Math.min(30,value));offsetWrites.push([id,clamped]);return clamped;},get:()=>cached,set:(id,value)=>cacheWrites.push([id,value]),remove(){}},api:{lyrics:q=>{requests.push(q);return request(q);}},
  session:{act:(action,args)=>seeks.push([action,args])},X:()=>null,SeekBar:()=>null,Pause:()=>null,Play:()=>null,
 });
 const tree=Component({item,close(){},open:true});
 return {tree,effects,changes,seeks,requests,cacheWrites,scrolls,offsetWrites,focused:()=>focused,returned:()=>returned};
}
test('synced sheet highlights the current line; only host/solo may seek by tapping lyrics',()=>{
 for(const role of [null,'host','guest']) {
  const h=sheetHarness({role}), nodes=flatten(h.tree), lines=nodes.filter(n=>n.props?.['data-line-index']!==undefined);
  assert.equal(lines.length,2); assert.equal(lines[1].props['aria-current'],'true');
  assert.equal(lines[0].props.disabled,role==='guest'); lines[0].props.onClick();
  assert.equal(h.seeks.length,role==='guest'?0:1);
  if(role!=='guest') assert.equal(h.seeks[0][1].position,5);
  const seek=nodes.find(n=>n.type?.name==='SeekBar'); assert.equal(seek.props.stacked,true);assert.equal(seek.props.open,true);
 }
});
test('static-only and empty/error/loading states disable sync and offer the expected controls',()=>{
 for(const options of [{data:{plain:'Static only'}},{data:{plain:null,synced:null}},{status:'error'},{status:'loading'}]) {
  const h=sheetHarness(options),nodes=flatten(h.tree),sync=nodes.find(n=>n.type==='button'&&n.props.children==='同步');
  if(!options.status) assert.equal(sync.props.disabled,true);
  const strings=JSON.stringify(nodes.filter(n=>n.type==='p'||n.type==='button').map(n=>n.props.children));
  assert.match(strings,options.status==='loading'?/正在查找歌词/:options.status==='error'?/歌词加载失败/:options.data.plain?/Static only/:/没有找到歌词/);
  if(options.status==='error'||!options.status&&!options.data.plain) assert.match(strings,/重新获取/);
 }
});
test('cache is used before fetch; late track responses are ignored after cleanup',async()=>{
 const data={plain:'Cached'}, hit=sheetHarness({cached:data}); hit.effects[1]();
 assert.equal(hit.requests.length,0); assert.equal(hit.changes.at(-2)[1].data,data);
 let resolve; const h=sheetHarness({request:()=>new Promise(r=>resolve=r)}),cleanup=h.effects[1]();
 assert.equal(h.requests.length,1); cleanup(); resolve({plain:'Late'}); await new Promise(r=>setImmediate(r));
 assert.equal(h.cacheWrites.length,0); assert.equal(h.changes.length,2);
 const local=sheetHarness({item:{id:'local',title:'recording',artist:'本地文件',source:'local'}}); local.effects[1](); assert.equal(local.requests.length,0);
});
test('active lyric is centred and reduced motion uses an immediate scroll; focus is restored',()=>{
 for(const reduced of [false,true]) {
  const h=sheetHarness({reduced}),cleanup=h.effects[0]();assert.equal(h.focused(),1);
  h.effects[2]();assert.equal(h.scrolls[0].top,104);assert.equal(h.scrolls[0].behavior,reduced?'auto':'smooth');
  cleanup();assert.equal(h.returned(),1);
 }
});
test('lyrics API uses authenticated HTTP for host/solo and always RPC for guests',async()=>{
 for(const role of [null,'host','guest']) {
  const calls=[],api=vm.runInNewContext(`({${between('  async lyrics(', '  /** GET /api/search?q=&sources= */')}})`,{
   account:{assertActive:async()=>{}},get:()=>({role,apiMode:'live'}),URLSearchParams,AbortSignal,
   authHeaders:()=>({Authorization:'Bearer token'}),apiUrl:path=>`/music-api${path}`,
   rpc:async(method,args)=>{calls.push({method,args});return {plain:'Via host'};},
   fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({plain:'Direct'})};},
  });
  await api.lyrics({title:'Song',artist:'Artist',duration:100});
  if(role==='guest') {assert.equal(calls[0].method,'lyrics');assert.equal(calls[0].args.title,'Song');}
  else {assert.match(calls[0].url,/api\/lyrics\?/);assert.equal(calls[0].options.headers.Authorization,'Bearer token');}
 }
});
test('host handles lyrics RPC with the existing reply/error channel',async()=>{
 const sent=[];
 const handle=vm.runInNewContext(`${between('async function handleRpc(', '// ════════════════════════════════════════════════════════════ UI 组件')};handleRpc`,{
  get:()=>({apiMode:'live'}),session:{send:m=>sent.push(m)},api:{lyrics:async q=>({synced:`[00:01]${q.title}`,plain:null,source:'lrclib'})},
 });
 await handle({id:'req',method:'lyrics',args:{title:'Song'}});
 assert.equal(sent[0].type,'rpc-result');assert.equal(sent[0].id,'req');assert.equal(sent[0].result.synced,'[00:01]Song');
});

test('offset controls advance highlighting, persist half-second changes and correct tap-to-seek',()=>{
 const h=sheetHarness({offset:1,position:9}),nodes=flatten(h.tree);
 assert.equal(nodes.find(n=>n.props?.['data-line-index']===1).props['aria-current'],'true');
 nodes.find(n=>n.props?.['data-line-index']===0).props.onClick(); assert.equal(h.seeks[0][1].position,4);
 nodes.find(n=>n.props?.['aria-label']==='歌词偏移增加 0.5 秒').props.onClick();
 assert.deepEqual(h.offsetWrites.at(-1),['song',1.5]); assert.equal(h.changes.at(-1)[1].value,1.5);
 nodes.find(n=>n.props?.['aria-label']==='歌词偏移减少 0.5 秒').props.onClick(); assert.deepEqual(h.offsetWrites.at(-1),['song',0.5]);
 nodes.find(n=>n.props?.['aria-label']==='重置歌词偏移').props.onClick(); assert.deepEqual(h.offsetWrites.at(-1),['song',0]);
 for(const offset of [-30,30]) {
  const limit=flatten(sheetHarness({offset}).tree);
  assert.equal(limit.find(n=>n.props?.['aria-label']===`歌词偏移${offset<0?'减少':'增加'} 0.5 秒`).props.disabled,true);
 }
});
test('lyrics cleanup keeps icon-only play control, conditionally shows timing hint and greys zero offset',()=>{
 const nodes=flatten(sheetHarness({data:{synced:'[00:01]A',source:'lrclib'}}).tree);
 const play=nodes.find(n=>n.props?.class==='fsp-lyrics-play');
 assert.equal(play.props['aria-label'],'暂停'); assert.equal(typeof play.props.children,'object');
 assert.ok(!nodes.some(n=>String(n.props?.children).includes('歌词来源：LRCLIB')));
 assert.ok(nodes.some(n=>n.type==='p'&&n.props.children==='歌词按原版时长匹配，不同步时可微调偏移'));
 assert.equal(nodes.find(n=>n.props?.['aria-label']==='重置歌词偏移').props.disabled,true);
 const plain=flatten(sheetHarness({data:{plain:'Plain'}}).tree);
 assert.ok(!plain.some(n=>n.type==='p'&&n.props.children==='歌词按原版时长匹配，不同步时可微调偏移'));
});
