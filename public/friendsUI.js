import React, { useEffect, useState } from 'react';
import htm from 'htm';
const html = htm.bind(React.createElement);
const button = 'rounded-xl border border-ink-600 px-3 py-2 text-sm hover:text-host disabled:opacity-40';
// Identity comes exclusively from this account's server response, never hh.name
// (which can still belong to a different account on a shared device).
export function FriendIdentity({ friend }) {
  return html`<span><span className="block">${friend.nickname || friend.username || friend.shortId || friend.id}</span>${friend.username && html`<span className="block text-xs font-normal text-sand-400">(@${friend.username})</span>`}</span>`;
}
export function coListeningLabel(username, seconds = 0) {
  const minutes = Math.floor(Math.max(0, Number(seconds) || 0) / 60);
  return `与 @${username} 已共同收听 ${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}
export function FriendsPanel({ client, presence = {}, invite, history = [], stats }) {
  const [friends, setFriends] = useState([]), [query, setQuery] = useState(''), [results, setResults] = useState([]), [error, setError] = useState('');
  const refresh = async () => { const data = await client.request('/account/friends'); setFriends(data.friends || data); };
  const run = async fn => { try { setError(''); await fn(); await refresh(); } catch (e) { setError(e.message); } };
  useEffect(() => { if (!client.required || !client.user?.isActivated) return; run(async () => {}); const timer = setInterval(() => run(async () => {}), 15000); return () => clearInterval(timer); }, [client.user?.id]);
  if (!client.required) return html`<p>好友功能需要登录并激活账号。</p>`;
  return html`<section class="space-y-5">
    <h1 class="text-2xl font-bold">好友 / 动态</h1>
    <p class="break-all text-xs text-sand-400">我的 ID：${client.user?.shortId || client.user?.short_id || '正在加载'}</p>
    <form class="flex gap-2" onSubmit=${e => { e.preventDefault(); run(async () => { const data = await client.request(`/account/users?q=${encodeURIComponent(query)}`); setResults(data.users || data); }); }}>
      <input class="min-w-0 flex-1 rounded-xl bg-ink-800 p-3" aria-label="搜索好友" placeholder="短 ID、用户名或昵称" value=${query} onInput=${e => setQuery(e.target.value)} required /><button class=${button}>搜索</button>
    </form>
    ${error && html`<p role="alert" class="text-guest">${error}</p>`}
    ${results.map(u => html`<div key=${u.id} class="flex items-center justify-between gap-3"><${FriendIdentity} friend=${u} /><button class=${button} onClick=${() => run(() => client.request('/account/friends', { userId: u.id }))}>添加好友</button></div>`)}
    <div class="space-y-3">${friends.map(f => {
      const id = f.userId || f.id, online = presence[id]?.online;
      return html`<article key=${id} class=${`rounded-2xl border p-4 space-y-3 ${online ? 'border-sync/50 bg-sync/5' : 'border-ink-700'}`}>
        <div class="flex items-center justify-between gap-3 font-semibold"><${FriendIdentity} friend=${f} /><span class="text-xs text-sand-400">${online ? '在线' : '离线'}</span></div>
        ${f.status === 'accepted' && html`<p class="text-xs text-sand-400">${coListeningLabel(f.username || f.nickname || id, stats?.coListeningSeconds?.(id))}</p>`}
        ${presence[id]?.nowPlaying && html`<p class="text-xs text-sand-400">正在听：${presence[id].nowPlaying.title || presence[id].nowPlaying}</p>`}
        <div class="flex flex-wrap gap-2">${f.status === 'accepted' ? html`<button class=${button} disabled=${!online} onClick=${() => invite(id)}>邀请一起听</button><button class=${button} onClick=${() => run(() => client.request(`/account/friends/${id}`, null, 'DELETE'))}>移除好友</button>`
          : f.requester === client.user?.id ? html`<span>等待对方接受</span><button class=${button} onClick=${() => run(() => client.request(`/account/friends/${id}`, null, 'DELETE'))}>取消请求</button>`
          : html`<button class=${button} onClick=${() => run(() => client.request(`/account/friends/${id}/accept`, {}))}>接受</button><button class=${button} onClick=${() => run(() => client.request(`/account/friends/${id}/decline`, {}))}>拒绝</button>`}</div>
      </article>`;
    })}${!friends.length && html`<p class="text-sand-400">搜索好友，邀请对方一起听歌。</p>`}</div>
    <h2 class="font-semibold">最近一起听</h2>
    ${history.map(h => html`<p key=${h.sessionId} class="text-sm text-sand-400">${h.nickname} · ${new Date(h.at).toLocaleString('zh-CN')}</p>`)}
  </section>`;
}
