// playQueue.js — 播放队列控制算法（纯逻辑，无 DOM / 无 React，Node 下可直接单测）
//
// 四种模式：
//   order    顺序播放：播到最后一首停止
//   loopAll  列表循环：最后一首之后回到第一首
//   loopOne  单曲循环：自然播完重播当前；手动"下一首"仍然切到下一首（与主流播放器一致）
//   shuffle  随机播放
//
// 随机播放不打乱歌单本身（歌单顺序 / 当前曲目在歌单里的位置都不变），而是维护一份独立的播放顺序：
//   bag       本轮还没播过的曲目，Fisher–Yates 洗牌后的顺序；next() 依次取出
//   round     本轮已经播过的曲目：一轮之内每首只播一次，全部播完才开始新一轮
//   history   已播栈：上一首 = 真正上一首听过的歌，而不是歌单里的前一首
//   forward   从 history 回退时把当前曲目压到这里，再按"下一首"会原路返回（像浏览器的前进 / 后退）
// 新一轮洗牌时，避免把刚播完的那首排在第一个（否则会连续听到同一首）。
// 播放中歌单增删：新歌随机插进本轮剩余部分（本轮就能听到），删掉的歌从各个栈里移除。
//
// 用法：
//   const q = new PlayQueue({ mode: 'shuffle' });
//   q.setTracks(ids, currentId);            // 每次操作前同步一下歌单（增删由它自己对齐）
//   const id = q.peekNext({ auto: true });  // 自然播完时的下一首（null = 停止）
//   q.moveTo(id, 'auto');                   // 真正切过去后提交
//   const prev = q.peekPrev(); q.moveTo(prev, 'prev');

export const PLAY_MODES = ['order', 'loopAll', 'loopOne', 'shuffle'];
export const MODE_LABEL = { order: '顺序播放', loopAll: '列表循环', loopOne: '单曲循环', shuffle: '随机播放' };
const HISTORY_MAX = 500;

/** Fisher–Yates 洗牌（原地），random 可注入以便测试 */
export function shuffleInPlace(arr, random = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class PlayQueue {
  ids = [];
  current = null;
  history = [];
  forward = [];
  bag = [];
  round = new Set();

  /** @param {{ mode?: string, random?: () => number }} [opts] */
  constructor({ mode = 'order', random = Math.random } = {}) {
    this.random = random;
    this.mode = PLAY_MODES.includes(mode) ? mode : 'order';
  }

  /**
   * 与歌单对齐。ids 为歌单顺序，currentId 为正在播放的曲目（可能为 null）。
   * 只做增量调整：已有的洗牌顺序、历史都保留。
   */
  setTracks(ids, currentId = this.current) {
    const set = new Set(ids);
    const changed = currentId !== this.current;
    this.ids = [...ids];
    this.current = currentId != null && set.has(currentId) ? currentId : null;
    this.history = this.history.filter((id) => set.has(id));
    this.forward = this.forward.filter((id) => set.has(id));
    this.round = new Set([...this.round].filter((id) => set.has(id)));
    if (this.current) this.round.add(this.current);
    // 当前曲目只在"从外部换了歌"时移出本轮；新一轮开始时它合法地排在 bag 后面，不能删
    this.bag = this.bag.filter((id) => set.has(id) && !(changed && id === this.current));
    if (this.mode === 'shuffle') {
      // 新加的歌：随机插入本轮剩余部分
      const known = new Set([...this.bag, ...this.round, ...this.forward]);
      for (const id of ids) {
        if (known.has(id)) continue;
        this.bag.splice(Math.floor(this.random() * (this.bag.length + 1)), 0, id);
      }
    }
    return this;
  }

  setMode(mode) {
    if (!PLAY_MODES.includes(mode) || mode === this.mode) return this;
    const wasShuffle = this.mode === 'shuffle';
    this.mode = mode;
    this.forward = [];
    if (mode === 'shuffle') {
      // 进入随机：当前这首继续播（位置不变），从剩下的歌开始新一轮
      this.round = new Set(this.current ? [this.current] : []);
      this.bag = this.newBag();
    } else if (wasShuffle) {
      this.bag = [];
      this.round = new Set();
    }
    return this;
  }

  /** 循环切换到下一个模式 */
  cycleMode() {
    return this.setMode(PLAY_MODES[(PLAY_MODES.indexOf(this.mode) + 1) % PLAY_MODES.length]).mode;
  }

  newBag() {
    return shuffleInPlace(
      this.ids.filter((id) => id !== this.current && !this.round.has(id)),
      this.random,
    );
  }

  /**
   * 本轮播完：全部歌曲重新洗牌开新一轮。
   * 刚播完的那首也在新一轮里（否则它会被整轮跳过），只是不能排第一个：
   * 洗出来恰好排在第一时，和后面随机一个位置交换。
   */
  newRound() {
    this.round = new Set();
    const bag = shuffleInPlace([...this.ids], this.random);
    if (bag.length > 1 && bag[0] === this.current) {
      const j = 1 + Math.floor(this.random() * (bag.length - 1));
      [bag[0], bag[j]] = [bag[j], bag[0]];
    }
    this.bag = bag;
  }

  /**
   * 下一首（不提交）。auto = 自然播完触发。
   * @returns {string|null} null 表示应该停止
   */
  peekNext({ auto = false } = {}) {
    const n = this.ids.length;
    if (!n) return null;
    if (auto && this.mode === 'loopOne' && this.current) return this.current;
    if (this.forward.length) return this.forward[this.forward.length - 1];
    const i = this.ids.indexOf(this.current);
    switch (this.mode) {
      case 'order':
        return i < 0 ? this.ids[0] : (this.ids[i + 1] ?? null);
      case 'loopAll':
      case 'loopOne':
        return i < 0 ? this.ids[0] : this.ids[(i + 1) % n];
      case 'shuffle':
        if (!this.bag.length) {
          if (n === 1) return this.current ?? this.ids[0];
          this.newRound();
        }
        return this.bag[0] ?? null;
    }
    return null;
  }

  /** 上一首（不提交）。随机模式下是真正听过的上一首；没有历史时返回 null */
  peekPrev() {
    if (!this.ids.length) return null;
    if (this.mode === 'shuffle') return this.history[this.history.length - 1] ?? null;
    const i = this.ids.indexOf(this.current);
    if (i < 0) return this.ids[0];
    if (i > 0) return this.ids[i - 1];
    return this.mode === 'order' ? null : this.ids[this.ids.length - 1];
  }

  /**
   * 提交切歌。via：'next' | 'auto'（下一首）· 'prev'（上一首）· 'select'（用户点播）
   */
  moveTo(id, via = 'select') {
    if (id == null || !this.ids.includes(id)) return this;
    if (id === this.current) return this; // 单曲循环重播：状态不变
    const prevId = this.current;
    if (via === 'prev') {
      // 回退：当前曲目进入 forward 栈，history 弹出目标
      if (this.history[this.history.length - 1] === id) this.history.pop();
      if (prevId) this.forward.push(prevId);
    } else {
      if (prevId) {
        this.history.push(prevId);
        if (this.history.length > HISTORY_MAX) this.history.shift();
      }
      if ((via === 'next' || via === 'auto') && this.forward[this.forward.length - 1] === id) this.forward.pop();
      else this.forward = []; // 走了一条新路：前进栈作废
    }
    this.current = id;
    this.round.add(id);
    this.bag = this.bag.filter((x) => x !== id); // 点播 / 回退过的歌本轮不再随机到
    return this;
  }

  /** 供 UI / 调试：接下来 k 首的预览（不改变状态以外的随机性：只看当前 bag） */
  upcoming(k = 5) {
    if (this.mode !== 'shuffle') {
      const out = [];
      let cur = this.current;
      const save = this.current;
      for (let j = 0; j < k; j++) {
        this.current = cur;
        const nx = this.peekNext();
        if (!nx || out.includes(nx)) break;
        out.push(nx);
        cur = nx;
      }
      this.current = save;
      return out;
    }
    return [...this.forward].reverse().concat(this.bag).slice(0, k);
  }

  toJSON() {
    return { mode: this.mode, current: this.current, history: this.history.slice(-100), forward: this.forward, bag: this.bag, round: [...this.round] };
  }

  /** 从 toJSON() 的结果恢复（例如刷新页面后继续同一轮随机） */
  static from(state, opts = {}) {
    const q = new PlayQueue({ ...opts, mode: state?.mode });
    if (!state) return q;
    q.current = state.current ?? null;
    q.history = state.history || [];
    q.forward = state.forward || [];
    q.bag = state.bag || [];
    q.round = new Set(state.round || []);
    return q;
  }
}
