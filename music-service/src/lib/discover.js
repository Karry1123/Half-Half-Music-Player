// The same key is used for uploads and aggregation across accounts/devices.
export const normalizeSongPart = value => String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
export const songKey = (title, artist) => JSON.stringify([normalizeSongPart(title), normalizeSongPart(artist)]);

export function isTrendingSong({ title, artist }) {
  const name = normalizeSongPart(title);
  return !!name && [...name].length <= 30 &&
    !/bv[0-9a-z]{10}|【[^】]*】|p\d+|合集|高清修复|4k|车载|慢摇|纯享版|live\s*录播|直播|录屏/iu.test(name) &&
    !/_official|up主|录播/iu.test(normalizeSongPart(artist));
}

export function validatePlays(body) {
  const invalid = () => { throw Object.assign(new Error('无效的收听统计数据'), { status: 400, code: 'INPUT' }); };
  if (!body || typeof body.deviceId !== 'string' || !/^[\w-]{8,100}$/.test(body.deviceId) || !Array.isArray(body.plays) || body.plays.length > 500) invalid();
  const seen = new Set();
  return body.plays.map(row => {
    if (!row || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200 || typeof row.artist !== 'string' || row.artist.length > 200 || !Number.isSafeInteger(row.completed) || row.completed < 0 || row.completed > 100000000 || (row.cover != null && (typeof row.cover !== 'string' || row.cover.length > 2000))) invalid();
    const key = songKey(row.title, row.artist);
    if (seen.has(key)) invalid();
    seen.add(key);
    return { key, title: row.title.trim(), artist: row.artist.trim(), cover: /^https:\/\//i.test(row.cover || '') ? row.cover : '', completed: row.completed };
  });
}
