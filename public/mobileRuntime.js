import { nativePlugin } from './nativeBridge.js';
// One owner for Android back events. Layers are ordered by opening time.
const layers = [];
export function pushBackLayer(close) {
  const layer = { close };
  layers.push(layer);
  return () => { const i = layers.indexOf(layer); if (i >= 0) layers.splice(i, 1); };
}

export function createBackHandler({ keyboard, navigate, notify, exit, now = Date.now }) {
  let lastPress = null;
  return () => {
    if (layers.length) { lastPress = null; layers.at(-1).close(); return; }
    if (keyboard() || navigate()) { lastPress = null; return; }
    const time = now();
    if (lastPress !== null && time - lastPress < 2000) { lastPress = null; exit(); }
    else { lastPress = time; notify('再按一次退出应用'); }
  };
}

export async function installAndroidBack(options) {
  const cap = window.Capacitor;
  if (cap?.getPlatform?.() !== 'android') return () => {};
  const app = nativePlugin('App');
  const handle = await app.addListener('backButton', createBackHandler({
    ...options, exit: () => app.exitApp(),
    keyboard: () => {
      const el = document.activeElement;
      if (el?.matches('input, textarea, [contenteditable="true"]')) { el.blur(); return true; }
      return false;
    },
  }));
  return () => handle.remove();
}
