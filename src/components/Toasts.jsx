import { useSession } from '../store/useSession.js';
import { Avatar } from './Avatar.jsx';
import { useToast } from '../store/useToast.js';
import { Icon } from './Icon.jsx';

/** 同步提示："晚风 把进度拖到了 02:15" */
export function Toasts() {
  const notices = useSession((s) => s.notices);
  const peer = useSession((s) => s.peer);
  const current = useToast((s) => s.current);
  return (
    <div className="toasts" aria-live="polite" aria-atomic="true">
      {current && <div className={`toast toast-app ${current.kind}`} key={current.id}>
        <Icon name={current.icon} size={20} /><span>{current.text}</span>
      </div>}
      {notices.slice(-1).map((n) => (
        <div className="toast toast-peer" key={n.id}>
          <Avatar profile={peer} size={24} />
          {n.text}
        </div>
      ))}
    </div>
  );
}
