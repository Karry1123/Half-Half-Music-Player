import { useSession } from '../store/useSession.js';
import { Avatar } from './Avatar.jsx';

/** 同步提示："晚风 把进度拖到了 02:15" */
export function Toasts() {
  const notices = useSession((s) => s.notices);
  const peer = useSession((s) => s.peer);
  return (
    <div className="toasts" aria-live="polite">
      {notices.map((n) => (
        <div className="toast" key={n.id}>
          <Avatar profile={peer} size={24} />
          {n.text}
        </div>
      ))}
    </div>
  );
}
