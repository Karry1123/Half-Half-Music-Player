// Theme ↔ system bars. The inline <head> script picks the theme before first paint; this module keeps
// the status / gesture bar icon colour, the browser theme-color and the <html> flags in step with it,
// and follows the OS when the user has not pinned a theme in localStorage ('hh-theme').
export const THEME_COLORS = { light: '#f7f0e8', dark: '#0e0c0b' };

export function resolveTheme(stored, prefersDark) {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersDark ? 'dark' : 'light';
}

export function installThemeSync({ doc = document, storage = globalThis.localStorage, media = globalThis.matchMedia, systemBars = null } = {}) {
  const query = typeof media === 'function' ? media('(prefers-color-scheme: dark)') : null;
  const stored = () => { try { return storage?.getItem('hh-theme'); } catch { return null; } };
  let meta = doc.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = doc.createElement('meta'); meta.name = 'theme-color'; doc.head.appendChild(meta); }
  const apply = (theme) => {
    doc.documentElement.dataset.theme = theme;
    doc.documentElement.classList.toggle('dark', theme === 'dark');
    meta.content = THEME_COLORS[theme];
    // Capacitor: DARK = light icons on a dark background, LIGHT = dark icons on a light background.
    systemBars?.setStyle({ style: theme === 'dark' ? 'DARK' : 'LIGHT' })?.catch?.(() => {});
    return theme;
  };
  apply(resolveTheme(stored(), !!query?.matches));
  const follow = () => apply(resolveTheme(stored(), !!query?.matches));
  query?.addEventListener?.('change', follow);
  return { apply, follow, dispose: () => query?.removeEventListener?.('change', follow) };
}
