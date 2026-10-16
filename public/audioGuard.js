// Pure decisions, independent of the DOM/native bridge. Time is injectable for tests.
export function createAudioGuardState({ clock = Date.now, autoResume = () => true, timeout = 300000 } = {}) {
  let transientAt = null, blocked = false, ducked = false;
  return {
    get blocked() { return blocked; },
    get ducked() { return ducked; },
    get remaining() { return transientAt === null ? 0 : Math.max(0, timeout - (clock() - transientAt)); },
    get waiting() { return transientAt !== null && clock() - transientAt < timeout && autoResume(); },
    cancelResume() { transientAt = null; },
    interact() { transientAt = null; blocked = false; ducked = false; },
    decide(event, playing) {
      if (event === 'gain') {
        const resume = this.waiting;
        transientAt = null; ducked = false;
        if (resume) blocked = false;
        return resume ? 'resume' : 'restore';
      }
      if (event === 'lossTransientCanDuck') {
        if (playing && !blocked) { ducked = true; return 'duck'; }
        return 'none';
      }
      if (!['loss', 'lossTransient', 'becomingNoisy', 'browserPause'].includes(event)) return 'none';
      ducked = false;
      if (event !== 'lossTransient') transientAt = null;
      if (!playing) return 'none';
      blocked = true;
      if (event === 'lossTransient' && transientAt === null && autoResume()) transientAt = clock();
      return 'pause';
    },
  };
}

export function outputDevices(devices) {
  return new Set(devices.filter(d => d.kind === 'audiooutput' && /headphones?|headset|earbuds?|bluetooth|耳机|蓝牙/i.test(d.label || '') && d.deviceId && !['default', 'communications'].includes(d.deviceId)).map(d => d.deviceId));
}
export function outputDisappeared(before, after) {
  return !!before && [...before].some(id => !after.has(id));
}

export function installAudioGuard({ audio, isPlaying, pause, resume, setDucking, publish,
  nativePlugin, capacitor = globalThis.Capacitor, navigator = globalThis.navigator,
  autoResume, clock = Date.now, timeout = 300000, consumeAppPause = () => false,
  ignorePause = () => false, pauseDelay = 500 }) {
  const state = createAudioGuardState({ clock, autoResume, timeout });
  const native = !!capacitor?.isNativePlatform?.();
  let lastPlay = -Infinity, pauseTimer, generation = 0;
  let plugin, ready = Promise.resolve(), queue = Promise.resolve(), timer, focused = false, disposed = false;
  const handles = [];
  const serial = fn => { queue = queue.then(() => ready).then(fn).catch(console.warn); };
  const abandon = () => { focused = false; serial(async () => { await plugin?.abandonFocus(); focused = false; }); };
  const changed = () => { setDucking(state.ducked ? 0.3 : 1); publish(); };
  const event = kind => {
    if (disposed) return;
    const decision = state.decide(kind, isPlaying());
    clearTimeout(timer);
    if (state.waiting) timer = setTimeout(() => { state.decide('loss', false); abandon(); changed(); }, state.remaining);
    if (decision === 'pause') pause(kind);
    if (decision === 'resume') resume();
    if (state.blocked && !state.waiting) abandon();
    changed();
  };
  const started = () => {
    lastPlay = clock(); generation++; clearTimeout(pauseTimer);
    if (state.blocked) { pause('loss'); return; }
    serial(async () => {
      if (disposed || !isPlaying() || focused || !plugin) return;
      try {
        const result = await plugin.requestFocus();
        focused = result?.granted !== false;
        if (!focused && isPlaying()) event('loss');
      } catch (e) { console.warn(e); }
    });
  };
  const paused = () => {
    if (consumeAppPause()) { if (!isPlaying() && !state.waiting) abandon(); return; }
    if (!isPlaying()) { if (!state.waiting) abandon(); return; }
    const source = audio.currentSrc || audio.src, token = ++generation;
    clearTimeout(pauseTimer);
    // load()/seek/buffering and preview playback are not external interruptions.
    const valid = () => !disposed && token === generation && audio.paused && !audio.ended &&
      !audio.seeking && !(audio.readyState < 3) && !ignorePause() &&
      source === (audio.currentSrc || audio.src) && isPlaying();
    if (!valid()) return;
    pauseTimer = setTimeout(async () => {
      if (!valid()) return;
      if (!native) { event('browserPause'); return; }
      try {
        // With our elements stopped, active media belongs to another player.
        const result = await plugin?.getInterruption();
        if (valid() && result?.state) event(result.state);
      } catch (e) { console.warn(e); }
    }, pauseDelay);
  };
  const ended = () => { if (!isPlaying()) abandon(); };
  if (native && nativePlugin) {
    try {
      plugin = nativePlugin('AudioGuard'); // nativeBridge uses registerPlugin('AudioGuard').
      ready = Promise.all([
        plugin.addListener('becomingNoisy', () => event('becomingNoisy')),
        plugin.addListener('interruption', ({ state }) => event(state)),
      ]).then(list => { handles.push(...list); if (disposed) list.forEach(h => h.remove()); }).catch(console.warn);
    } catch (e) { console.warn(e); }
  }
  let outputs;
  let devicesQueue = Promise.resolve();
  const devices = navigator?.mediaDevices;
  const devicechange = () => {
    devicesQueue = devicesQueue.then(async () => {
      const list = await devices.enumerateDevices();
      const next = outputDevices(list);
      if (disposed) return;
      // Permission/visibility redaction is not evidence of a disconnected device.
      if (!next.size && list.some(d => d.kind === 'audiooutput' && (!d.label || !d.deviceId))) {
        outputs = undefined; return;
      }
      if (isPlaying() && clock() - lastPlay >= 3000 && outputDisappeared(outputs, next)) event('becomingNoisy');
      outputs = next;
    }).catch(() => {});
    return devicesQueue;
  };
  if (!native && devices?.addEventListener && devices?.enumerateDevices) {
    devices.addEventListener('devicechange', devicechange); devicechange();
  }
  audio.addEventListener('play', started);
  audio.addEventListener('pause', paused);
  audio.addEventListener('ended', ended);
  return {
    get blocked() { return state.blocked; },
    get waiting() { return state.waiting; },
    event,
    cancelResume() { clearTimeout(timer); state.cancelResume(); changed(); if (!isPlaying()) abandon(); },
    interact() { clearTimeout(timer); state.interact(); changed(); if (!isPlaying()) abandon(); },
    dispose() { disposed = true; generation++; clearTimeout(pauseTimer); clearTimeout(timer); abandon(); handles.forEach(h => h.remove());
      audio.removeEventListener('play', started); audio.removeEventListener('pause', paused); audio.removeEventListener('ended', ended);
      devices?.removeEventListener?.('devicechange', devicechange); },
  };
}
