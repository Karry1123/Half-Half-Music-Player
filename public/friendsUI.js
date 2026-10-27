import React, { useEffect, useState } from 'react';
import htm from 'htm';
import { coverSrc, coverError } from './coverUrl.js';
const html = htm.bind(React.createElement);
const button = 'shrink-0 rounded-xl border border-ink-600 px-3 py-2 text-sm hover:text-host disabled:opacity-40';
export function useFriends(client, onError = () => {}, interval = 15000) {
  const id = client.user?.id;
  const [snapshot, setSnapshot] = useState(() => ({ id, friends: client.getCachedFriends() }));
  useEffect(() => {
    const setFriends = friends => setSnapshot({ id, friends });
    setFriends(client.getCachedFriends());
    if (!client.required || !client.user?.isActivated) return;
    let stopped = false, timer;
    const unsubscribe = client.subscribeFriends(setFriends);
    const refresh = async () => {
      clearTimeout(timer);
      if (document.hidden || stopped) return;
      try { await client.loadFriends(); } catch (e) { if (!stopped) onError(e.message); }
      clearTimeout(timer);
      if (!stopped && !document.hidden && interval > 0) timer = setTimeout(refresh, interval);
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', visibility);
    refresh();
    return () => { stopped = true; clearTimeout(timer); unsubscribe(); document.removeEventListener('visibilitychange', visibility); };
  }, [client, client.user?.id, client.user?.isActivated, interval]);
  return snapshot.id === id ? snapshot.friends : client.getCachedFriends();
}
// Identity comes exclusively from this account's server response, never hh.name
// (which can still belong to a different account on a shared device).
export function FriendIdentity({ friend }) {
  return html`<span className="min-w-0 flex-1 break-words"><span className="block">${friend.nickname || friend.username || friend.shortId || friend.id}</span>${friend.username && html`<span className="block text-xs font-normal text-sand-400">(@${friend.username})</span>`}</span>`;
}
export function coListeningLabel(username, seconds = 0) {
  const minutes = Math.floor(Math.max(0, Number(seconds) || 0) / 60);
  return `与 @${username} 已共同收听 ${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}
export function FriendsPanel({ client, presence = {}, invite, history = [], stats, onPreview, onCollect }) {
  const [query, setQuery] = useState(''), [results, setResults] = useState([]), [error, setError] = useState('');
  const friends = useFriends(client, setError);
  const [, revise] = useState(0);
  useEffect(() => {
    let timer;
    const unsubscribe = stats?.subscribe(() => {
      if (!timer && !document.hidden) timer = setTimeout(() => { timer = null; revise(n => n + 1); }, 1000);
    });
    return () => { unsubscribe?.(); clearTimeout(timer); };
  }, [stats]);
  const [publicLibrary, setPublicLibrary] = useState(null), [publicPlaylist, setPublicPlaylist] = useState(null), [publicLoading, setPublicLoading] = useState(false), [collected, setCollected] = useState('');
  const openPublic = async (id, friend) => {
    setError(''); setPublicLoading(true); setPublicPlaylist(null); setCollected('');
    try { const data = await client.request(`/account/friends/${encodeURIComponent(id)}/playlists`); setPublicLibrary({ friend, playlists: data.playlists || data }); }
    catch (e) { setError(e.message); } finally { setPublicLoading(false); }
  };
  const publicAction = async fn => { try { setError(''); await fn(); } catch (e) { setError(e.message); } };
  const refresh = () => client.loadFriends({ force: true });
  const run = async fn => { try { setError(''); await fn(); await refresh(); } catch (e) { setError(e.message); } };
  if (!client.required) return html`<p>好友功能需要登录并激活账号。</p>`;
  return html`<section className="friends-panel space-y-5">
    <h1 className="text-2xl font-bold">好友 / 动态</h1>
    <p className="break-all text-xs text-sand-400">我的 ID：${client.user?.shortId || client.user?.short_id || '正在加载'}</p>
    <form className="flex gap-2" onSubmit=${e => { e.preventDefault(); run(async () => { const data = await client.request(`/account/users?q=${encodeURIComponent(query)}`); setResults(data.users || data); }); }}>
      <input className="min-w-0 flex-1 rounded-xl bg-ink-800 p-3" aria-label="搜索好友" placeholder="短 ID、用户名或昵称" value=${query} onInput=${e => setQuery(e.target.value)} required /><button className=${button}>搜索</button>
    </form>
    ${error && html`<p role="alert" className="text-guest">${error}</p>`}
    ${results.map(u => html`<div key=${u.id} className="flex items-center justify-between gap-3"><${FriendIdentity} friend=${u} /><button className=${button} onClick=${() => run(() => client.request('/account/friends', { userId: u.id }))}>添加好友</button></div>`)}
    <div className="space-y-3">${friends.map(f => {
      const id = f.userId || f.id, online = presence[id]?.online;
      return html`<article key=${id} className=${`rounded-2xl border p-4 space-y-3 ${online ? 'border-sync/50 bg-sync/5' : 'border-ink-700'}`}>
        <div className="flex items-center justify-between gap-3 font-semibold"><${FriendIdentity} friend=${f} /><span className="text-xs text-sand-400">${online ? '在线' : '离线'}</span></div>
        ${f.status === 'accepted' && html`<p className="text-xs text-sand-400">${coListeningLabel(f.username || f.nickname || id, stats?.coListeningSeconds?.(id))}</p>`}
        ${presence[id]?.nowPlaying && html`<p className="text-xs text-sand-400">正在听：${presence[id].nowPlaying.title || presence[id].nowPlaying}</p>`}
        <div className="flex flex-wrap gap-2">${f.status === 'accepted' ? html`<button className=${button} disabled=${publicLoading} onClick=${() => openPublic(id, f)}>TA的公开歌单</button><button className=${button} disabled=${!online} onClick=${() => invite(id)}>邀请一起听</button><button className=${button} onClick=${() => run(() => client.request(`/account/friends/${id}`, null, 'DELETE'))}>移除好友</button>`
          : f.requester === client.user?.id ? html`<span>等待对方接受</span><button className=${button} onClick=${() => run(() => client.request(`/account/friends/${id}`, null, 'DELETE'))}>取消请求</button>`
          : html`<button className=${button} onClick=${() => run(() => client.request(`/account/friends/${id}/accept`, {}))}>接受</button><button className=${button} onClick=${() => run(() => client.request(`/account/friends/${id}/decline`, {}))}>拒绝</button>`}</div>
      </article>`;
    })}${!friends.length && html`<p className="text-sand-400">搜索好友，邀请对方一起听歌。</p>`}</div>
    ${publicLibrary && html`<section className="space-y-3 rounded-2xl border border-ink-600 bg-ink-800/60 p-4">
      <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">${publicLibrary.friend.nickname || publicLibrary.friend.username || '好友'}的公开歌单</h2><button className=${button} onClick=${() => { setPublicLibrary(null); setPublicPlaylist(null); }}>关闭</button></div>
      ${publicLibrary.playlists.length ? publicLibrary.playlists.map(p => html`<button key=${p.id} className="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-ink-700" onClick=${() => { setPublicPlaylist(p); setCollected(''); }}>${(p.coverUrl || p.cover) && html`<img onError=${e => coverError(e, p)} referrerPolicy="no-referrer" src=${coverSrc(p.coverUrl || p.cover)} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" loading="lazy" />`}<span className="min-w-0 flex-1"><span className="block truncate">${p.name}</span><span className="block text-xs text-sand-400">${(p.tracks || []).length} 首歌曲</span></span></button>`) : html`<p className="text-sm text-sand-400">TA还没有公开歌单。</p>`}
      ${publicPlaylist && html`<div className="space-y-3 border-t border-ink-600 pt-3"><div className="flex items-center justify-between gap-2"><h3>${publicPlaylist.name}</h3><button className=${button} disabled=${!onCollect} onClick=${() => publicAction(async () => { await onCollect(publicPlaylist); setCollected('已收藏至我的歌单'); })}>收藏至我的歌单</button></div>${collected && html`<p role="status" className="text-sm text-sync">${collected}</p>`}${(publicPlaylist.tracks || []).map((t, i) => html`<button key=${t.sourceId || i} className="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-ink-700" disabled=${!onPreview} onClick=${() => publicAction(() => onPreview(t))}>${t.cover && html`<img onError=${e => coverError(e, t)} referrerPolicy="no-referrer" src=${coverSrc(t.cover)} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" loading="lazy" />`}<span className="min-w-0 flex-1"><span className="block truncate">${t.title}</span><span className="block truncate text-xs text-sand-400">${t.artist}</span></span><span className="text-xs text-sand-400">试听</span></button>`)}</div>`}
    </section>`}
    <h2 className="font-semibold">最近一起听</h2>
    ${history.map(h => html`<p key=${h.sessionId} className="text-sm text-sand-400">${h.nickname} · ${new Date(h.at).toLocaleString('zh-CN')}</p>`)}
  </section>`;
}
