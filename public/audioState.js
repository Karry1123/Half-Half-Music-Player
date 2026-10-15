// UI snapshots always come from the media element, independent of sync anchors.
export function audioSnapshot(audio) {
  return { position: Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0,
    duration: Number.isFinite(audio.duration) ? Math.max(0, audio.duration) : 0, playing: !audio.paused && !audio.ended };
}
export function observeAudio(audio, publish, document, app) {
  const update = () => publish(audioSnapshot(audio));
  const visible = () => { if (!document.hidden) update(); };
  const events = ['timeupdate', 'seeked', 'loadedmetadata', 'play', 'pause', 'ended', 'emptied'];
  events.forEach(e => audio.addEventListener(e, update));
  document.addEventListener('visibilitychange', visible);
  let disposed = false, handle;
  app?.addListener('appStateChange', ({ isActive }) => { if (isActive) update(); }).then(h => { if (disposed) h.remove(); else handle = h; }).catch(console.warn);
  update();
  return () => { disposed = true; handle?.remove(); events.forEach(e => audio.removeEventListener(e, update)); document.removeEventListener('visibilitychange', visible); };
}
