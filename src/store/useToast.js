import { create } from 'zustand';

export const useToast = create(() => ({ current: null }));
let timer;
let sequence = 0;

// One app message at a time: every call replaces it and restarts its lifetime.
export function toast(text, { icon = 'check', kind = 'info', key = 'app' } = {}) {
  clearTimeout(timer);
  const id = ++sequence;
  useToast.setState({ current: { id, text, icon, kind, key } });
  timer = setTimeout(() => useToast.setState({ current: null }), 2200);
}
