// Recent listening is derived only from measured playback, never from library order.
export function recentListening(records = [], metadata = {}, library = []) {
  const latest = new Map();
  for (const record of records) {
    if (!(record.durationPlayed > 0) || !Number.isFinite(record.timestamp)) continue;
    if (!latest.has(record.trackId) || latest.get(record.trackId) < record.timestamp) latest.set(record.trackId, record.timestamp);
  }
  return [...latest].sort((a, b) => b[1] - a[1]).flatMap(([id, listenedAt]) => {
    const meta = metadata[id];
    const track = library.find(t => t.localId === id || t.id === id || (meta?.hash && t.hash === meta.hash) || (meta?.sourceId && t.sourceId === meta.sourceId));
    return track || meta?.title ? [{ ...(track || meta), id: track?.id || id, available: !!track, listenedAt }] : [];
  });
}
