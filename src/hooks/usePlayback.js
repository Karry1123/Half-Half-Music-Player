import { useEffect, useRef, useState } from 'react';
import { engine } from '../engine/session.js';

/** 每帧读取播放位置（秒）。只让调用它的小组件重渲染，而不是整棵树。 */
export function usePlaybackPosition() {
  const reducedMotion = useReducedMotion();
  const [pos, setPos] = useState(() => engine.position());
  useEffect(() => {
    if (reducedMotion) {
      const timer = setInterval(() => setPos(engine.position()), 1000);
      return () => clearInterval(timer);
    }
    let raf;
    let last = -1;
    const tick = () => {
      const p = engine.position();
      // 位置变化不足 50ms 不更新，省掉大部分无意义的重渲染
      if (Math.abs(p - last) >= 0.05) {
        last = p;
        setPos(p);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion]);
  return pos;
}

/** requestAnimationFrame 循环（可视化用），回调拿到 AnalyserNode */
export function useAnimationFrame(callback, active = true) {
  const cb = useRef(callback);
  cb.current = callback;
  useEffect(() => {
    if (!active) return;
    let raf;
    const loop = () => {
      cb.current();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

/** Decorative animations follow the live accessibility preference. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}
