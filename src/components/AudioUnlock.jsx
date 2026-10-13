import { engine } from '../engine/session.js';
import { useSession } from '../store/useSession.js';
import { Icon } from './Icon.jsx';

/**
 * 浏览器自动播放策略拦截时的提示条。
 * 常见触发：通过链接进入后还没点过页面、iOS 锁屏/来电后 AudioContext 被中断、移动端切后台。
 * 同步时间轴不受影响——点击后直接跳到"现在应该在的位置"继续。
 */
export function AudioUnlock() {
  const blocked = useSession((s) => s.audioBlocked);
  const state = useSession((s) => s.audioState);
  if (!blocked) return null;
  return (
    <div className="unlock-banner" role="alert">
      <Icon name="mute" size={18} />
      <span>浏览器暂停了声音{state === 'interrupted' ? '（被系统中断）' : ''}，播放进度仍在同步</span>
      <button className="btn guest" onClick={() => engine.unlockAudio()}>
        <Icon name="volume" size={16} />
        点击开启声音
      </button>
    </div>
  );
}
