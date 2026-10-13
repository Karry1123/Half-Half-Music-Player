// 文本归一化 + 版本判定 + 排序打分
import { Converter } from 'opencc-js';

// 繁体 → 简体，"告白氣球" 与 "告白气球" 视为同一词
const toSimplified = Converter({ from: 'tw', to: 'cn' });

const NOISE =
  /official\s*(music\s*)?(video|mv|audio)|lyrics?\s*video|\blyrics?\b|歌词版?|动态歌词|官方(完整)?(版)?\s*mv|高音质|无损(音质)?|\b(hd|hq|4k|1080p|mv|m\/v)\b/gi;
// 只匹配最内层括号，循环剥离以处理嵌套："(電影《Passengers》中文主題曲)"
const BRACKETS = /[(\[（【《「『〔][^(\[（【《「『〔)\]）】》」』〕]*[)\]）】》」』〕]/g;

// 现场版：歌手对，但不是录音室原版
const LIVE_CJK = ['现场', '演唱会', '巡回', '音乐节', '春晚', '晚会', '盛典', '颁奖', '舞台', '综艺'];
const LIVE_LATIN = ['live', 'concert', 'tour'];
// 电视台/综艺频道上传的基本都是舞台现场（标题里往往不写 live）
const TV_UPLOADER = /卫视|电视台|芒果tv|smg|cctv|央视|湖南|东方卫视|综艺|mangotv|ztv|jstv|dragon tv/;
// 翻唱 / 改编 / 二创
// "原唱：XX" / "原曲：XX" 说明唱的人不是原唱
const COVER_CJK = ['原唱', '原曲', '对唱', '街头', '路演', '中韩版', '韩语版', '日语版', '英文版', '泰语版', '越南语版', '翻唱', '翻自', '鼓谱', '吉他谱', '曲谱', '乐谱', '教程', '演奏', '翻弹', '指弹', '架子鼓', '小提琴', '萨克斯', '笛子', '伴奏', '纯音乐', '变速', '加速', '降调', '升调', '倍速', '钢琴', '吉他', '古筝', '二胡', '口琴', '女声版', '男声版', '童声', '抖音', '鼠鼠', 'dj版', '改编', '哼唱', '合唱版', '弹唱', '教学', '片段', '铃声', '串烧', '混剪'];
const COVER_LATIN = ['cover', 'covered', 'remix', 'dj', 'instrumental', 'karaoke', 'ktv', 'piano', 'guitar', '8d', 'reverb', 'slowed', 'nightcore', 'sped up', 'mashup', 'bootleg', 'acapella', 'tutorial'];

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function norm(s = '') {
  return toSimplified(s.normalize('NFKC')).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
}

/** 去掉括号内容和 MV/歌词等噪声词后的"核心标题" */
export function coreTitle(title) {
  let s = title;
  for (let prev; prev !== s; ) s = (prev = s).replace(BRACKETS, ' ');
  return norm(s.replace(NOISE, ' ')) || norm(title);
}

/** 文本里是否出现某个词：CJK 子串匹配，拉丁文按整词匹配（避免 "live" 命中 "oliver"） */
export function hasTerm(text, term) {
  if (!term) return false;
  if (CJK.test(term)) return text.includes(term);
  return new RegExp(`(^|\\s)${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(text);
}

/** 文本含有某类词，且关键词里没有（用户明确搜 live / remix 时不算变体） */
function variantOf(text, nq, cjk, latin) {
  return cjk.some((t) => text.includes(t) && !nq.includes(t)) || latin.some((t) => hasTerm(text, t) && !hasTerm(nq, t));
}
export const isLive = (text, nq = '') => variantOf(text, nq, LIVE_CJK, LIVE_LATIN);
export const isCover = (text, nq = '') => variantOf(text, nq, COVER_CJK, COVER_LATIN);

/** 歌手名的可匹配别名："G.E.M. 鄧紫棋" → ["g e m 邓紫棋", "邓紫棋"]；"周杰倫 Jay Chou" → [..., "周杰伦", "jay chou"] */
export function artistAliases(name) {
  const n = norm(name);
  const out = new Set([n]);
  const tokens = n.split(' ');
  for (const t of tokens) if (CJK.test(t) && [...t].length >= 2) out.add(t);
  const latin = tokens.filter((t) => !CJK.test(t)).join(' ');
  if (latin.length >= 4) out.add(latin);
  return [...out].filter(Boolean);
}

export const VERSION_ORDER = { original: 0, variant: 1, live: 2, unknown: 3, cover: 4, other: 5 };
export const VERSION_LABEL = { original: '原版', variant: '原唱其他版本', live: '现场', unknown: '未标明原唱', cover: '翻唱/改编', other: '无关' };

// 括号里的 "X版" 多是原唱的重录/改版（重生版、热爱版、新版、旧版…）；这些写法则只是描述原版本身
const SAME_VERSION = /^(原|正式|完整|官方|高清|无损|修复|mv|录音室|单曲|专辑|电影|动态歌词|歌词|高音质|音频|纯享|收藏|cd)版?$/;
const ALT_LATIN = /\b(acoustic|demo|re-?recorded|remaster(ed)?|radio edit|extended|version|ver)\b/i;

/** 标题括号里是否标注了非原始录音的版本 */
function isAltVersion(title) {
  const inner = [...title.matchAll(/[(\[（【《「『〔]([^(\[（【《「『〔)\]）】》」』〕]+)[)\]）】》」』〕]/g)].map((m) => m[1]);
  return inner.some((s) => {
    if (ALT_LATIN.test(s)) return true;
    return norm(s)
      .split(' ')
      .some((w) => /版$/.test(w) && !SAME_VERSION.test(w));
  });
}

/**
 * 判定一条结果是哪个版本；原版/现场同时返回匹配到的原唱 singer。
 * @param originals findOriginals() 的结果；为空表示没识别出原唱，此时只能区分翻唱/现场
 */
export function classify(track, originals, query) {
  const nq = norm(query);
  const titleText = norm(`${track.title} ${track.album || ''}`);
  // 演唱者只信任：音源给出的歌手 + 标题；上传者名只有官方频道才算（防止"XX粉丝团"误判）
  const text = norm(`${track.title} ${track.artists.join(' ')} ${track.official ? track.uploader || '' : ''}`);

  if (track.category === '翻唱' || isCover(titleText, nq)) return { version: 'cover' };
  if (!originals.length) return { version: isLive(titleText, nq) ? 'live' : 'unknown' };

  const titleHit = originals.some((o) => o.titles.some((t) => text.includes(t)));
  if (!titleHit) return { version: 'other' };
  const singer = originals.find((o) => o.aliases.some((a) => hasTerm(text, a)));
  if (!singer) return { version: 'unknown' };
  // 音源/标题给出了演唱者，但不是原唱 → 翻唱
  //   "蔡佩軒 - 周杰倫【告白氣球】"、"G.E.M.【光年之外】 - 蔡佩軒"：不含歌名的那一侧才是演唱者
  const isOriginalName = (name) => originals.some((o) => o.aliases.some((a) => hasTerm(norm(name), a)));
  const sides = track.artistGuessed ? [track.artist, track.title] : track.artists;
  const performers = sides.filter((s) => s && !titleHitOf(s, originals));
  if (performers.length && !performers.some(isOriginalName)) return { version: 'cover' };
  if (isLive(titleText, nq) || TV_UPLOADER.test(norm(track.uploader || ''))) return { version: 'live', singer };
  // 比原版短很多 → 剪辑/片段；MV 常带前奏或彩蛋会更长，所以只卡下限
  if (singer.duration && track.duration && track.duration < singer.duration * 0.7) return { version: 'other' };
  if (isAltVersion(track.title)) return { version: 'variant', singer };
  return { version: 'original', singer };
}

/** "A - B" 拆分可能把歌名当成歌手（"告白气球 - 周二珂"），这种不算演唱者 */
function titleHitOf(name, originals) {
  const n = norm(name);
  return originals.some((o) => o.titles.some((t) => n.includes(t)));
}

/**
 * 同一版本内的排序分：
 *   关键词覆盖率 40 + 播放量 log10×4 + 官方音源 15 / 官方频道 8 + 收藏 UP 10 + 平台原始排序 0~5
 */
export function score(track, query, index) {
  const nq = norm(query);
  const hay = norm(`${track.title} ${track.artists.join(' ')} ${track.album || ''}`);
  const qTokens = nq.split(' ').filter(Boolean);
  const hit = qTokens.filter((t) => hay.includes(t)).length;
  let s = qTokens.length ? (hit / qTokens.length) * 40 : 0;
  if (track.plays) s += Math.log10(track.plays + 1) * 4;
  if (track.source === 'ytmusic') s += 15; // 唱片公司上架的原始母带音轨
  else if (track.official) s += 8;
  if (track.trusted) s += 10;
  s += Math.max(0, 5 - index * 0.5);
  return Math.round(s * 10) / 10;
}
