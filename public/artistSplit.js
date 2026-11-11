// Decides whether an artist field names one act or several, so a collaboration can be credited
// to each performer. Unambiguous markers (feat., 、 ; ，) always split. Ambiguous ones (& / , x
// and with +) split only when every part is already known as an artist on its own, or when the
// user has said so; otherwise the field stays whole and a question is reported for the UI to ask.
import { toSimplified } from './zhVariants.js';

export const artistKey = value => toSimplified(String(value || '')).normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');

const FEAT = /\s*[\(\[（【]\s*(?:feat\.?|ft\.?|featuring)\s+([^\)\]）】]+)[\)\]）】]/giu;
const CERTAIN = /(?:\s*[+&＋＆]\s*|\s+)(?:featuring|feat|ft)(?:[.:：]\s*|\s+)|\s*[、;；，]\s*/giu;
const AMBIGUOUS = /\s*[&＆\/／,+＋×]\s*|\s+(?:x|and|with|vs\.?)\s+/giu;
// Acts whose own name contains an ambiguous marker.
const WHOLE = new Set([
  'ac/dc', 'simon & garfunkel', 'earth, wind & fire', 'tyler, the creator', 'hall & oates', 'crosby, stills & nash',
  'crosby, stills, nash & young', 'emerson, lake & palmer', 'peter, paul and mary', 'blood, sweat & tears',
  'mumford & sons', 'belle & sebastian', 'brooks & dunn', 'coheed and cambria', 'chloe x halle', 'tomorrow x together',
  'iron & wine', 'she & him', 'angus & julia stone', 'above & beyond', 'matt and kim', 'florence + the machine',
  'of monsters and men', 'years & years', 'aly & aj', 'nico & vinz', 'dan + shay',
  'black country, new road', 'the mamas & the papas', 'captain & tennille', 'sam & dave', 'ike & tina turner',
  'macklemore & ryan lewis', 'me first and the gimme gimmes', 'now, now',
].map(artistKey));
// "Bob Marley & The Wailers", "Florence + the Machine": a leader and their band are one act.
const BAND = /(?:[&＆+＋]|\band\b)\s*(?:the|his|her|their)\s+\S/iu;

export function normalizeArtistNames(names) {
  if (!Array.isArray(names) || names.length < 2 || names.length > 6 || names.some(name => typeof name !== 'string')) return;
  const trimmed = names.map(name => name.trim());
  if (trimmed.some(name => !name || name.length > 100) || new Set(trimmed.map(artistKey)).size !== trimmed.length) return;
  return trimmed;
}
const split = (text, pattern) => text.split(pattern).map(part => part.trim()).filter(Boolean);
export const hasSeparator = value => { const text = String(value || ''); return [FEAT, CERTAIN, AMBIGUOUS].some(p => { p.lastIndex = 0; return p.test(text); }); };

/**
 * @param {string} name      raw artist field
 * @param {{ known?: Set<string>, decisions?: Record<string, 'split' | 'keep' | { answer: string, names?: string[] }> }} context
 * @returns {{ artists: string[], questions: { key: string, label: string, pieces: string[] }[],
 *   decided: { key: string, label: string, pieces: string[], defaultPieces: string[], answer: 'split' | 'keep' }[] }}
 */
export function resolveArtists(name, { known = new Set(), decisions = {} } = {}) {
  const raw = String(name || '').trim();
  if (!raw) return { artists: [], questions: [], decided: [] };
  const artists = [], questions = [], decided = [], seen = new Set();
  const add = artist => { const key = artistKey(artist); if (key && !seen.has(key)) { seen.add(key); artists.push(artist); } };
  const parts = split(raw.replace(FEAT, ' feat. $1'), CERTAIN);
  // Preserve decisions made before a marker became unambiguous.
  const rawDecision = decisions[artistKey(raw)];
  const rawAnswer = typeof rawDecision === 'string' ? rawDecision : rawDecision?.answer;
  if (parts.length > 1 && valid(rawAnswer)) {
    const defaultPieces = parts.flatMap(part => split(part, AMBIGUOUS));
    const pieces = rawAnswer === 'split' && normalizeArtistNames(rawDecision?.names) || defaultPieces;
    (rawAnswer === 'split' ? pieces : [raw]).forEach(add);
    decided.push({ key: artistKey(raw), label: raw, pieces, defaultPieces, answer: rawAnswer });
    return { artists, questions, decided };
  }
  for (const part of parts) {
    const pieces = split(part, AMBIGUOUS), key = artistKey(part);
    if (pieces.length < 2) { add(part); continue; }
    const decision = decisions[key];
    const answer = typeof decision === 'string' ? decision : decision?.answer;
    const effective = answer === 'split' && normalizeArtistNames(decision?.names) || pieces;
    // Parts the user has answered are reported so the answer can be shown and changed later.
    if (answer === 'split' || answer === 'keep') decided.push({ key, label: part, pieces: effective, defaultPieces: pieces, answer });
    if (answer === 'split') { effective.forEach(add); continue; }
    if (answer === 'keep' || WHOLE.has(key) || BAND.test(part)) { add(part); continue; }
    if (pieces.every(piece => known.has(artistKey(piece)))) { pieces.forEach(add); continue; }
    add(part);
    questions.push({ key, label: part, pieces });
  }
  return { artists, questions, decided };
}

// The user's answers: kept on this device with the time they were given, and synced through the
// account's listening sync so every device asks each question once. The newest answer wins.
const storageKey = 'hh.artistSplit';
const listeners = new Set();
const valid = answer => answer === 'split' || answer === 'keep';
let fallback = {};
function read() {
  try {
    if (!globalThis.localStorage) return fallback;
    const value = JSON.parse(globalThis.localStorage.getItem(storageKey) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = {};
    for (const [key, entry] of Object.entries(value)) {
      // Answers saved before syncing existed are plain strings without a time.
      const answer = typeof entry === 'string' ? entry : entry?.answer;
      if (valid(answer)) {
        const names = answer === 'split' && normalizeArtistNames(entry?.names);
        entries[key] = { answer, at: Number.isSafeInteger(entry?.at) && entry.at >= 0 ? entry.at : 0, ...(names ? { names } : {}) };
      }
    }
    return entries;
  } catch { return fallback; }
}
function write(entries) {
  fallback = entries;
  try { globalThis.localStorage?.setItem(storageKey, JSON.stringify(entries)); } catch {}
}
export const artistSplitStore = {
  /** Decisions accepted by resolveArtists, including custom names. */
  all() { return Object.fromEntries(Object.entries(read()).map(([key, entry]) => [key, entry.names ? { answer: entry.answer, names: entry.names } : entry.answer])); },
  /** [{ key, answer, at, names? }] for upload */
  entries() { return Object.entries(read()).map(([key, entry]) => ({ key, ...entry })); },
  decide(key, answer, at = Date.now(), names) {
    if (typeof key !== 'string' || !key || !valid(answer)) return;
    const normalized = answer === 'split' && normalizeArtistNames(names);
    if (!Number.isSafeInteger(at) || at < 0 || (names !== undefined && !normalized)) return;
    write({ ...read(), [key]: { answer, at, ...(normalized ? { names: normalized } : {}) } });
    listeners.forEach(fn => fn(key, 'local'));
  },
  /** Apply answers from other devices; an answer given here later is kept. */
  merge(rows) {
    const entries = { ...read() };
    let changed = false;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.key !== 'string' || !row.key || !valid(row.answer) || !Number.isSafeInteger(row.at) || row.at < 0) continue;
      const mine = entries[row.key];
      if (mine && mine.at >= row.at) continue;
      const names = row.answer === 'split' && normalizeArtistNames(row.names);
      if (row.names !== undefined && !names) continue;
      entries[row.key] = { answer: row.answer, at: row.at, ...(names ? { names } : {}) };
      changed = true;
    }
    if (changed) { write(entries); listeners.forEach(fn => fn(null, 'remote')); }
    return changed;
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
