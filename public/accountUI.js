import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { AlertTriangle, Check, CloudDownload, Cloud, FileArchive, Headphones, KeyRound, Loader2, LogOut, RefreshCw, X } from 'lucide-react';
import { createPlaylistZip, saveZip } from './playlistZip.js';
import { pushBackLayer } from './mobileRuntime.js';
const html = htm.bind(React.createElement);
const cx = (...c) => c.filter(Boolean).join(' ');
const primary = 'inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sync to-[#8fe3c9] px-4 py-3 text-sm font-semibold text-ink-950 shadow-lg shadow-sync/20 transition hover:brightness-110 active:scale-[.98] disabled:opacity-40';
const ghost = 'inline-flex items-center justify-center gap-1.5 rounded-xl border border-ink-600 px-3 py-2 text-xs font-medium text-sand-200 hover:border-sand-400 hover:text-sand-50 disabled:opacity-40';
const field = 'w-full rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm text-sand-50 outline-none placeholder:text-sand-500 focus:border-sync';
const mb = (n) => `${(n / 1048576).toFixed(n >= 104857600 ? 0 : 1)} MB`;

function useBack(open, close) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => (open ? pushBackLayer(() => ref.current()) : undefined), [open]);
}

function Logo({ size = 64 }) {
  return html`<div class="relative shrink-0" style=${{ width: size, height: size }}>
    <span class="absolute inset-0 rounded-full" style=${{ background: 'conic-gradient(#f2a65a 0 50%, #ec7a96 50% 100%)' }} />
    <span class="absolute inset-[30%] rounded-full bg-ink-950" />
    <${Headphones} size=${Math.round(size * 0.36)} class="absolute inset-0 m-auto text-sand-50" />
  </div>`;
}

function Alert({ children, tone = 'warn' }) {
  return html`<p role="alert" class=${cx('flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-relaxed', tone === 'warn' ? 'border-guest/30 bg-guest/10 text-guest' : 'border-sync/30 bg-sync/10 text-sync')}>
    <${tone === 'warn' ? AlertTriangle : Check} size=${14} class="mt-0.5 shrink-0" /><span class="min-w-0 whitespace-pre-wrap break-words">${children}</span>
  </p>`;
}

export function AccountGate({ client, children }) {
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [code, setCode] = useState(''), [register, setRegister] = useState(false);
  const refresh = () => { setError(''); setReady(false); client.init().then(() => setReady(true)).catch(e => setError(`账号服务连接失败：${e.message}`)); };
  useEffect(refresh, []);
  const submit = async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { if (client.user) await client.activate(code); else await client.login(username, password, register); setPassword(''); setCode(''); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  if (ready && (!client.required || client.user?.isActivated)) return children;
  const step = client.user ? 2 : 1;
  const title = !ready ? '连接账号服务' : client.user ? '激活账号' : register ? '创建账号' : '登录';
  const hint = !ready ? '正在确认音乐服务是否在线，首次唤醒可能需要几十秒。'
    : client.user ? '输入一次性邀请码。激活后，这个账号在任何设备登录都不用再填。'
    : register ? '账号用于在多台设备间同步歌单；音频只保存在各自设备上。' : '登录后自动同步你的云端歌单。';
  return html`<main class="flex min-h-screen justify-center px-5" style=${{ paddingTop: 'calc(var(--safe-top, 0px) + 56px)', paddingBottom: 'calc(var(--safe-bottom, 0px) + 24px)' }}>
    <div class="w-full max-w-sm">
      <div class="mb-8 flex flex-col items-center text-center">
        <${Logo} />
        <div class="mt-4 text-2xl font-extrabold tracking-tight">Half<span class="text-gradient">&</span>Half</div>
        <p class="mt-1 text-sm text-sand-400">一人一半，耳机分你一只</p>
      </div>
      <section class="rounded-3xl border border-ink-700 bg-ink-900/80 p-5 shadow-2xl backdrop-blur" aria-labelledby="acct-title">
        ${ready && client.required && html`<ol class="mb-4 flex items-center gap-2 text-[11px] text-sand-500" aria-label="步骤">
          ${['登录账号', '邀请码激活'].map((s, i) => html`<li key=${s} class=${cx('flex items-center gap-1.5', i + 1 <= step && 'text-sand-200')}>
            <span class=${cx('grid h-5 w-5 place-items-center rounded-full text-[10px] font-semibold', i + 1 < step ? 'bg-sync text-ink-950' : i + 1 === step ? 'bg-host text-ink-950' : 'bg-ink-700 text-sand-400')}>${i + 1 < step ? html`<${Check} size=${11} />` : i + 1}</span>${s}
            ${i === 0 && html`<span class="mx-1 h-px w-6 bg-ink-600" />`}
          </li>`)}
        </ol>`}
        <h1 id="acct-title" class="text-lg font-semibold">${title}</h1>
        <p class="mt-1 text-xs leading-relaxed text-sand-400">${hint}</p>
        <div class="mt-4 space-y-3">
          ${error && html`<${Alert}>${error}<//>`}
          ${!ready
            ? error ? html`<button class=${primary} onClick=${refresh}><${RefreshCw} size=${16} /> 重新连接</button>`
              : html`<div class="flex items-center justify-center gap-2 py-6 text-sm text-sand-400"><${Loader2} size=${16} class="animate-spin" /> 正在连接…</div>`
            : html`<form onSubmit=${submit} class="space-y-3">
              ${client.user
                ? html`<div class="flex items-center gap-2 rounded-xl bg-black/20 px-3 py-2 text-xs text-sand-300">已登录<strong class="truncate text-sand-50">${client.user.username}</strong></div>
                  <label class="relative block"><${KeyRound} size=${16} class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sand-500" />
                    <input class=${cx(field, 'pl-10 font-mono tracking-wide')} aria-label="邀请码" placeholder="邀请码" autoComplete="one-time-code" autoCapitalize="off" spellCheck="false" value=${code} onInput=${e => setCode(e.target.value)} required /></label>`
                : html`<input class=${field} aria-label="账号" autoComplete="username" autoCapitalize="off" spellCheck="false" placeholder="账号（字母、数字，3 位以上）" value=${username} onInput=${e => setUsername(e.target.value)} required />
                  <input class=${field} aria-label="密码" type="password" autoComplete=${register ? 'new-password' : 'current-password'} minLength=${register ? 12 : 1} maxLength="128" placeholder=${register ? '密码（至少 12 位）' : '密码'} value=${password} onInput=${e => setPassword(e.target.value)} required />`}
              <button class=${primary} disabled=${busy}>${busy ? html`<${Loader2} size=${16} class="animate-spin" /> 处理中…` : client.user ? '激活并进入' : register ? '注册' : '登录'}</button>
              ${client.user
                ? html`<button type="button" class="w-full py-1 text-xs text-sand-400 hover:text-sand-50" onClick=${async () => { await client.logout().catch(() => {}); refresh(); }}>换个账号登录</button>`
                : html`<button type="button" class="w-full py-1 text-xs text-sand-400 hover:text-sand-50" onClick=${() => { setRegister(!register); setError(''); }}>${register ? '已有账号？去登录' : '没有账号？创建一个'}</button>`}
            </form>`}
        </div>
      </section>
      <p class="mt-5 text-center text-[11px] leading-relaxed text-sand-500">未激活的账号无法使用搜索、下载、云端歌单与双人同步</p>
    </div>
  </main>`;
}

/** 云端同步面板：歌单在登录同一账号的设备间自动同步；这里看同步状态、手动同步、下载各歌单里还没下载的歌 */
export function CloudSheet({ open, onClose, client, status, playlists, onSync, onDownload, onOpen }) {
  useBack(open, onClose);
  if (!open || !client.required) return null;
  const syncing = status?.state === 'syncing';
  const when = status?.at ? new Date(status.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  const list = playlists.filter((p) => p.id !== 'all');
  const missing = list.reduce((n, p) => n + (p.pending?.length || 0), 0);
  return html`<div class="fixed inset-0 z-[75] flex items-end justify-center bg-ink-950/70 backdrop-blur-sm sm:items-center sm:p-6" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <section role="dialog" aria-modal="true" aria-labelledby="cloud-title" class="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-ink-700 bg-ink-900 shadow-2xl sm:rounded-3xl">
      <header class="flex items-center gap-3 border-b border-ink-700/70 px-5 py-4">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sync/15 text-sync"><${Cloud} size=${19} /></span>
        <div class="min-w-0 flex-1">
          <h2 id="cloud-title" class="font-semibold">云端同步</h2>
          <p class="truncate text-xs text-sand-500">${client.user?.username} · 歌单在所有登录设备间自动同步</p>
        </div>
        <button class="grid h-8 w-8 place-items-center rounded-full text-sand-400 hover:bg-ink-800 hover:text-sand-50" onClick=${onClose} aria-label="关闭"><${X} size=${17} /></button>
      </header>
      <div class="scroll-thin flex-1 space-y-3 overflow-y-auto p-4">
        <div class="flex items-center gap-3 rounded-2xl border border-ink-700 bg-ink-850/60 px-4 py-3">
          <span class=${cx('grid h-8 w-8 shrink-0 place-items-center rounded-full', status?.state === 'error' ? 'bg-guest/15 text-guest' : 'bg-sync/15 text-sync')}>
            ${syncing ? html`<${Loader2} size=${15} class="animate-spin" />` : status?.state === 'error' ? html`<${AlertTriangle} size=${15} />` : html`<${Check} size=${15} />`}
          </span>
          <span class="min-w-0 flex-1 text-sm">
            <span class="block font-medium">${syncing ? '正在同步…' : status?.state === 'error' ? '同步失败' : status?.at ? '已同步' : '等待同步'}</span>
            <span class="block truncate text-xs text-sand-500">${status?.state === 'error' ? status.error : when ? `上次同步 ${when} · 修改后自动同步` : '修改歌单后会自动同步'}</span>
          </span>
          <button class=${cx(ghost, 'shrink-0')} disabled=${syncing} onClick=${onSync}><${RefreshCw} size=${14} class=${syncing ? 'animate-spin' : ''} /> 立即同步</button>
        </div>
        <p class="px-1 text-xs leading-relaxed text-sand-500">只同步歌单和歌曲信息，不上传音频。其他设备加入的歌会显示为「未下载」，需要时下载到这台设备即可；在这台设备删除文件不会影响歌单。</p>
        <div class="space-y-2">
          ${list.map((p) => {
            const n = p.pending?.length || 0;
            return html`<div key=${p.id} class="flex items-center gap-3 rounded-2xl border border-ink-700 bg-ink-850/60 px-3 py-2.5">
              <button class="min-w-0 flex-1 text-left" onClick=${() => onOpen(p.id)} title="打开这个歌单">
                <span class="block truncate text-sm font-medium">${p.name}</span>
                <span class="text-xs text-sand-500 tabular">${p.trackIds.length + n} 首${n ? ` · ${n} 首未下载` : ' · 已全部在本机'}</span>
              </button>
              ${n ? html`<button class=${cx(ghost, 'shrink-0 border-sync/50 text-sync hover:border-sync hover:text-sync')} onClick=${() => onDownload(p.id)}><${CloudDownload} size=${14} /> 下载 ${n} 首</button>`
                : html`<${Check} size=${16} class="mr-1 shrink-0 text-sync" />`}
            </div>`;
          })}
        </div>
        ${missing > 0 && html`<p class="px-1 text-[11px] text-sand-500">共 ${missing} 首未下载。打开歌单可以逐首下载或移除。</p>`}
      </div>
    </section>
  </div>`;
}

/** 歌单打包导出：variant = 'icon'（歌单标题栏）| 'chip'（本机曲库工具栏） */
export function ZipExport({ storage, name, trackIds, variant = 'chip' }) {
  const [open, setOpen] = useState(false), [tracks, setTracks] = useState([]), [checked, setChecked] = useState(new Set()), [busy, setBusy] = useState(false), [progress, setProgress] = useState(null), [error, setError] = useState(''), [done, setDone] = useState('');
  useBack(open, () => { if (!busy) setOpen(false); });
  const show = async () => {
    try {
      const all = await storage.listTracks(); const map = new Map(all.map(t => [t.id, t]));
      const list = trackIds ? trackIds.map(id => map.get(id)).filter(Boolean) : all;
      setTracks(list); setChecked(new Set(list.map(t => t.id))); setOpen(true); setError(''); setDone(''); setProgress(null);
    } catch (e) { alert(e.message); }
  };
  const chosen = tracks.filter(t => checked.has(t.id));
  const size = chosen.reduce((n, t) => n + (t.size || 0), 0);
  const pack = async () => {
    setBusy(true); setError(''); setDone('');
    try {
      const blob = await createPlaylistZip({ name, tracks: chosen, getBlob: storage.getBlob, onProgress: setProgress });
      await saveZip(blob, name, storage);
      setDone(storage.isNative ? '已生成 ZIP，请在系统弹出的应用中保存或分享' : '已生成 ZIP，浏览器开始下载');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const allOn = chosen.length === tracks.length;
  const trigger = variant === 'icon'
    ? html`<button class="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sand-400 hover:bg-white/5 hover:text-sand-50 disabled:opacity-40" disabled=${trackIds && !trackIds.length} onClick=${show} aria-label="打包导出歌单" title="打包导出歌单（ZIP）"><${FileArchive} size=${16} /></button>`
    : html`<button class="inline-flex items-center gap-1.5 rounded-lg border border-ink-600 px-2.5 py-1 text-xs text-sand-200 hover:border-sync hover:text-sync disabled:opacity-40" onClick=${show} title="把歌曲打包成一个 ZIP 文件"><${FileArchive} size=${13} /> 打包 ZIP</button>`;
  const pct = progress ? (progress.percent ? 50 + progress.percent / 2 : (progress.done / progress.total) * 50) : 0;
  return html`${trigger}${open && html`<div class="fixed inset-0 z-[80] flex items-end justify-center bg-ink-950/70 backdrop-blur-sm sm:items-center sm:p-6" onClick=${e => e.target === e.currentTarget && !busy && setOpen(false)}>
    <section role="dialog" aria-modal="true" aria-labelledby="zip-title" class="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-ink-700 bg-ink-900 shadow-2xl sm:rounded-3xl">
      <header class="flex items-center gap-3 border-b border-ink-700/70 px-5 py-4">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-host/15 text-host"><${FileArchive} size=${19} /></span>
        <div class="min-w-0 flex-1"><h2 id="zip-title" class="truncate font-semibold">打包导出《${name}》</h2>
          <p class="text-xs text-sand-500">文件名为「歌手 - 歌名」，附带 metadata.json</p></div>
        <button class="grid h-8 w-8 place-items-center rounded-full text-sand-400 hover:bg-ink-800 hover:text-sand-50" onClick=${() => !busy && setOpen(false)} aria-label="关闭"><${X} size=${17} /></button>
      </header>
      <div class="flex items-center justify-between px-5 pt-3 text-xs text-sand-400">
        <span class="tabular">已选 ${chosen.length}/${tracks.length} 首 · ${mb(size)}</span>
        <button class="text-sand-300 hover:text-sand-50 disabled:opacity-40" disabled=${busy || !tracks.length} onClick=${() => setChecked(allOn ? new Set() : new Set(tracks.map(t => t.id)))}>${allOn ? '全不选' : '全选'}</button>
      </div>
      <div class="scroll-thin flex-1 overflow-y-auto p-2">
        ${!tracks.length && html`<p class="py-8 text-center text-sm text-sand-500">这个歌单里还没有本机缓存的歌曲</p>`}
        ${tracks.map(t => html`<label key=${t.id} class="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 hover:bg-white/5">
          <input type="checkbox" class="h-4 w-4 shrink-0 accent-[#f2a65a]" checked=${checked.has(t.id)} disabled=${busy} onChange=${e => setChecked(s => { const n = new Set(s); e.target.checked ? n.add(t.id) : n.delete(t.id); return n; })} />
          <span class="min-w-0 flex-1"><span class="block truncate text-sm">${t.title}</span><span class="block truncate text-xs text-sand-500">${t.artist || '未知歌手'}${t.size ? ` · ${mb(t.size)}` : ''}</span></span>
        </label>`)}
      </div>
      <footer class="space-y-3 border-t border-ink-700/70 px-5 py-4">
        ${progress && busy && html`<div role="status" class="space-y-1.5 text-xs text-sand-300">
          <div class="tabular">${progress.percent ? `正在生成压缩包… ${Math.round(progress.percent)}%` : `正在打包 ${progress.done}/${progress.total}…`}</div>
          <div class="h-1.5 overflow-hidden rounded-full bg-ink-700"><div class="h-full rounded-full bg-host transition-all" style=${{ width: `${pct}%` }} /></div>
        </div>`}
        ${error && html`<${Alert}>${error}<//>`}
        ${done && html`<${Alert} tone="ok">${done}<//>`}
        <div class="flex gap-2">
          <button class="flex-1 rounded-xl border border-ink-600 px-4 py-2.5 text-sm text-sand-200 hover:border-sand-400 disabled:opacity-40" disabled=${busy} onClick=${() => setOpen(false)}>${done ? '完成' : '取消'}</button>
          <button class="inline-flex flex-[2] items-center justify-center gap-2 rounded-xl bg-host px-4 py-2.5 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-40" disabled=${busy || !chosen.length} onClick=${pack}>
            ${busy ? html`<${Loader2} size=${15} class="animate-spin" /> 打包中…` : `打包下载 ${chosen.length} 首`}
          </button>
        </div>
      </footer>
    </section>
  </div>`}`;
}

/** 设置面板里的账号卡片 */
export function AccountCard({ client, className = '' }) {
  const [busy, setBusy] = useState(false);
  if (!client.required || !client.user) return null;
  const logout = async () => {
    if (!confirm('退出账号？本机已缓存的歌曲和歌单会保留。')) return;
    setBusy(true);
    try { await client.logout(); } finally { location.reload(); }
  };
  return html`<section class=${className} aria-labelledby="set-account">
    <h3 id="set-account" class="text-xs font-semibold uppercase tracking-wider text-sand-500">账号</h3>
    <div class="flex items-center gap-3">
      <span class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sync/15 text-sm font-semibold uppercase text-sync">${client.user.username.slice(0, 1)}</span>
      <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">${client.user.username}</span>
        <span class="inline-flex items-center gap-1 text-xs text-sync"><${Check} size=${11} /> 已激活 · 全部服务可用</span></span>
      <button class=${cx(ghost, 'shrink-0 hover:border-guest hover:text-guest')} disabled=${busy} onClick=${logout}><${LogOut} size=${14} /> 退出</button>
    </div>
  </section>`;
}
