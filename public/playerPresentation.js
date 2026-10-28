import { nextTrackId } from './playQueue.js';

// Read the engine snapshot without advancing its queue or generating a new shuffle round.
export function upNextTracks(tracks, currentId, queue = {}) {
  const byId = new Map(tracks.map(track => [track.id, track]));
  const state = { ids: tracks.map(track => track.id), current: currentId, mode: queue.mode || 'order',
    forward: [...(queue.forward || [])].filter(id => byId.has(id)),
    bag: [...(queue.bag || [])].filter(id => byId.has(id)) };
  const seen = new Set(currentId ? [currentId] : []), result = [];
  for (let i = 0; i < tracks.length; i++) {
    const id = nextTrackId(state); // Manual next also advances in single-track repeat mode.
    if (!id || seen.has(id)) break;
    seen.add(id);
    result.push(byId.get(id));
    if (state.forward.at(-1) === id) state.forward.pop();
    else state.forward = [];
    state.bag = state.bag.filter(next => next !== id);
    state.current = id;
  }
  return result;
}
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
export function songResults(tracks, query) {
  const terms = normalize(query).split(' ').filter(Boolean);
  const score = track => terms.reduce((sum, term) => sum + (normalize(track.title) === term ? 8 : normalize(track.title).includes(term) ? 4 : normalize(track.artist).includes(term) ? 2 : 0), 0);
  const ranked = tracks.map((track, index) => ({ track, index, score: score(track) })).sort((a, b) => b.score - a.score || a.index - b.index);
  const best = ranked[0]?.track || null;
  const groups = [];
  for (const { track } of ranked.slice(1)) {
    const key = track.source || 'local';
    let group = groups.find(group => group.key === key);
    if (!group) { group = { key, label: track.sourceLabel || track.sourceName || key, tracks: [] }; groups.push(group); }
    group.tracks.push(track);
  }
  return { best, groups };
}
