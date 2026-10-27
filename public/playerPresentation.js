// Read-only presentation of existing tracks; never maintains a second queue.
export function upNextTracks(tracks, currentId) {
  const index = tracks.findIndex(track => track.id === currentId);
  return tracks.slice(index < 0 ? 0 : index + 1);
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
