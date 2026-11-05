// BS.1770 reference biquads at 48 kHz, transformed through the analogue
// domain so the poles/zeros retain their frequencies at the decoded rate.
function coefficients(b, a, rate) {
  const transform = ([c0, c1, c2]) => {
    const r = rate / 48000;
    const p0 = c0 + c1 + c2, p1 = 2 * (c0 - c2) * r, p2 = (c0 - c1 + c2) * r * r;
    return [p0 + p1 + p2, 2 * (p0 - p2), p0 - p1 + p2];
  };
  const num = transform(b), den = transform(a);
  return [...num.map(x => x / den[0]), den[1] / den[0], den[2] / den[0]];
}

function filter(samples, c) {
  const [b0, b1, b2, a1, a2] = c;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    samples[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
}

async function browserDecode(bytes) {
  const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  return new Context(1, 1, 48000).decodeAudioData(bytes);
}

export async function analyseTrack(blob, { decode = browserDecode } = {}) {
  const audio = await decode(await blob.arrayBuffer());
  const { sampleRate: rate, length, numberOfChannels: channels } = audio;
  const mono = new Float32Array(length);
  let peak = 0;
  for (let ch = 0; ch < channels; ch++) {
    const data = audio.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += data[i] / channels;
      peak = Math.max(peak, Math.abs(data[i]));
    }
  }
  const window = Math.max(1, Math.round(rate * 0.02));
  let first = length, last = 0;
  for (let i = 0; i < length; i += window) {
    const end = Math.min(length, i + window);
    let energy = 0;
    for (let j = i; j < end; j++) energy += mono[j] * mono[j];
    if (energy / (end - i) >= 1e-5) { first = Math.min(first, i); last = end; }
  }
  filter(mono, coefficients([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585], rate));
  filter(mono, coefficients([1, -2, 1], [1, -1.99004745483398, 0.99007225036621], rate));
  const block = Math.min(length, Math.max(1, Math.round(rate * 0.4)));
  const step = Math.max(1, Math.round(rate * 0.1));
  const energies = [];
  let sum = 0;
  for (let i = 0; i < length; i++) {
    sum += mono[i] * mono[i];
    if (i >= block) sum -= mono[i - block] * mono[i - block];
    if (i + 1 >= block && (i + 1 - block) % step === 0) energies.push(Math.max(0, sum / block));
  }
  const level = e => -0.691 + 10 * Math.log10(e);
  const absolute = energies.filter(e => level(e) >= -70);
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const threshold = absolute.length ? level(mean(absolute)) - 10 : -70;
  const gated = absolute.filter(e => level(e) >= threshold);
  // Finite silence sentinels survive JSON persistence on native storage.
  return { loudness: gated.length ? level(mean(gated)) : -120,
    peak: peak ? 20 * Math.log10(peak) : -120,
    leadIn: first / rate, trailOut: (length - last) / rate,
    duration: length / rate, version: 1 };
}

export function gainFor(loudness, { target = -16, maxBoost = 0 } = {}) {
  if (!Number.isFinite(loudness) || loudness <= -70) return 1;
  return 10 ** (Math.min(target - loudness, Math.max(0, maxBoost)) / 20);
}

export function trimBounds(analysis, duration) {
  if (!(duration > 0) || !analysis || analysis.version !== 1) return { start: 0, end: duration };
  const lead = Math.max(0, analysis.leadIn || 0), trail = Math.max(0, analysis.trailOut || 0);
  if (lead + trail >= duration) return { start: 0, end: duration };
  const start = Math.min(lead, 15, duration * 0.2);
  return { start, end: duration - Math.min(trail, 60, Math.max(0, duration * 0.2 - start)) };
}

// One decoder at a time. Playback jobs have priority over idle library work.
export function createAnalysisQueue({ analyse = analyseTrack, eligible, lookup, read, persist, apply,
  canRun, idle = fn => globalThis.requestIdleCallback ? requestIdleCallback(fn) : setTimeout(fn, 2000),
  retry = fn => setTimeout(fn, 2000) }) {
  const jobs = new Map();
  let running = false, scheduled = false;
  async function pump() {
    if (running || !jobs.size) return;
    const entry = [...jobs].find(([, job]) => job.blob) || jobs.entries().next().value;
    const [id, job] = entry;
    if (!canRun(!!job.blob)) return schedule(true);
    jobs.delete(id); running = true;
    try {
      const item = lookup(id);
      if (eligible(item) && item.analysis?.version !== 1) {
        const blob = job.blob || await read(id);
        if (blob && canRun(!!job.blob)) {
          const analysis = await analyse(blob);
          await persist(item.localId, analysis);
          apply(id, analysis);
        } else if (blob) jobs.set(id, job);
      }
    } catch (e) { console.warn('[audio analysis]', e); }
    finally { running = false; schedule(); }
  }
  function schedule(backoff = false) {
    if (!scheduled && jobs.size) {
      scheduled = true;
      (backoff ? retry : idle)(() => { scheduled = false; return pump(); });
    }
  }
  return { enqueue(id, blob) {
    const item = lookup(id);
    if (!eligible(item) || item.analysis?.version === 1) return;
    jobs.set(id, { blob: blob || jobs.get(id)?.blob });
    if (blob && !running) void pump(); else schedule();
  } };
}
