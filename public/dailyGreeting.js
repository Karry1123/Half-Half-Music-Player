import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Sunrise, Coffee, Sunset, Music, Moon } from 'lucide-react';
import { nativePlugin } from './nativeBridge.js';
const html = htm.bind(React.createElement);
export const GREETINGS = {
  dawn: { title: '清晨', lines: [
    '早上好。晨光刚落在窗边，配一首轻快的歌，愿今天从容开始。',
    '新的一天不必急着赶路，先听一首喜欢的歌，找到自己的节奏。',
    '早安。愿今天的风是温柔的，耳机里的歌也正好合你心意。',
  ] },
  afternoon: { title: '午后', lines: [
    '午安。忙了一上午，给自己留一首歌的空白，歇一歇再出发。',
    '午后的光正暖，泡杯茶，听点轻松的，愿下午一切顺利。',
    '一天已经走到中途，辛苦了。愿接下来的时间轻松一点。',
  ] },
  dusk: { title: '黄昏', lines: [
    '傍晚好。天色慢慢变柔，让今天的奔忙随着旋律轻轻落下。',
    '下班路上、回家途中，有首好听的歌陪着，路也会短一些。',
    '夕阳正好，愿你今天的辛苦都有回报，剩下的时光多一点舒展。',
  ] },
  evening: { title: '夜晚', lines: [
    '晚上好。今天辛苦了，找一首喜欢的歌，让心慢慢安定下来。',
    '夜色渐深，把手机音量调到刚好，这段时间只属于你自己。',
    '窗外渐渐安静，愿你听着喜欢的歌，收好这一天的微光。',
  ] },
  midnight: { title: '深夜', lines: [
    '夜深了，听完这首就早点休息吧，明天也会是好的一天。',
    '还没睡吗？挑一首安静的歌，让纷乱的思绪慢慢放下。',
    '深夜的旋律可以很轻，愿你今晚睡个好觉，做个好梦。',
  ] },
};
export function greetingBucket(hour) {
  if (hour >= 5 && hour <= 10) return 'dawn';
  if (hour >= 11 && hour <= 13) return 'afternoon';
  if (hour >= 14 && hour <= 18) return 'dusk';
  if (hour >= 19 && hour <= 23) return 'evening';
  return 'midnight';
}
export function localGreetingDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function greetingStorage() {
  return {
    async get() {
      try { return globalThis.Capacitor?.isNativePlatform?.() ? (await nativePlugin('Preferences').get({ key: 'lastGreetingDate' })).value : globalThis.localStorage?.getItem('lastGreetingDate'); } catch { return null; }
    },
    async set(value) {
      try { if (globalThis.Capacitor?.isNativePlatform?.()) await nativePlugin('Preferences').set({ key: 'lastGreetingDate', value }); else globalThis.localStorage?.setItem('lastGreetingDate', value); } catch {}
    },
  };
}
const shown = new WeakMap(), pending = new WeakMap();
// Serialize claims for the same storage adapter so remounts cannot show twice.
const defaultStorage = greetingStorage();
export async function claimDailyGreeting({ date = new Date(), storage = defaultStorage, random = Math.random } = {}) {
  const previous = pending.get(storage) || Promise.resolve();
  const claim = previous.catch(() => {}).then(async () => {
    const today = localGreetingDate(date);
    let last;
    try { last = await storage.get(); } catch {}
    if (shown.get(storage) === today || last === today) return null;
    shown.set(storage, today);
    try { await storage.set(today); } catch {}
    const bucket = greetingBucket(date.getHours()), group = GREETINGS[bucket];
    return { bucket, title: group.title, body: group.lines[Math.min(group.lines.length - 1, Math.max(0, Math.floor(random() * group.lines.length)))] };
  });
  pending.set(storage, claim);
  return claim;
}
export function DailyGreeting() {
  const [greeting, setGreeting] = useState(null), [closing, setClosing] = useState(false);
  const button = useRef(null), timer = useRef(null);
  useEffect(() => { let active = true; claimDailyGreeting().then(value => { if (active) setGreeting(value); }); return () => { active = false; clearTimeout(timer.current); }; }, []);
  useEffect(() => {
    if (!greeting) return;
    const previous = document.activeElement;
    button.current?.focus();
    const key = e => { if (e.key === 'Escape') close(); if (e.key === 'Tab') { e.preventDefault(); button.current?.focus(); } };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus?.(); };
  }, [greeting]);
  const close = () => { if (closing) return; setClosing(true); timer.current = setTimeout(() => setGreeting(null), globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 200); };
  if (!greeting) return null;
  const Icon = { dawn: Sunrise, afternoon: Coffee, dusk: Sunset, evening: Music, midnight: Moon }[greeting.bucket];
  return html`<div class=${`hh-greeting fixed inset-0 z-[100] grid place-items-center bg-black/50 p-6 backdrop-blur-md ${closing ? 'hh-greeting-out' : ''}`} onClick=${e => e.target === e.currentTarget && close()}><style>${`
    @keyframes hhGreetingIn { from {opacity:0;transform:scale(.95)} to {opacity:1;transform:scale(1)} }
    @keyframes hhGreetingOut { to {opacity:0;transform:scale(.96)} }
    .hh-greeting {animation:hhGreetingIn .28s ease both} .hh-greeting-out {animation:hhGreetingOut .2s ease both}
    @media(prefers-reduced-motion:reduce){.hh-greeting,.hh-greeting-out{animation:none}}
  `}</style><section role="dialog" aria-modal="true" aria-labelledby="greeting-title" aria-describedby="greeting-body" class="w-full max-w-sm rounded-3xl border border-white/20 bg-gradient-to-br from-host/20 via-ink-900/90 to-guest/20 p-8 text-center shadow-2xl backdrop-blur-xl"><${Icon} size=${36} class="mx-auto mb-5 text-host" /><h2 id="greeting-title" class="text-xl font-semibold">${greeting.title}，与你相遇</h2><p id="greeting-body" class="my-6 text-sm leading-8 text-sand-200">${greeting.body}</p><button ref=${button} class="w-full rounded-2xl bg-host py-3 text-sm font-semibold text-ink-950" onClick=${close}>开启音乐时光</button></section></div>`;
}
