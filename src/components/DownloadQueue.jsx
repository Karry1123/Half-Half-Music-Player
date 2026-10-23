import { useEffect, useRef } from 'react';
import { ACTIVE_DOWNLOADS, useMusic } from '../store/useMusic.js';
import { useSession } from '../store/useSession.js';
import { AudioUnlock } from './AudioUnlock.jsx';
import { Icon } from './Icon.jsx';

const STATUS = { queued: '排队中', downloading: '下载中', processing: '处理中', done: '已完成', error: '下载失败' };
const rank = (j) => j.status === 'error' ? 0 : ACTIVE_DOWNLOADS.includes(j.status) ? 1 : 2;

export function DownloadQueueButton() {
  const count = useMusic((s) => Object.values(s.jobs).filter((j) => j.status === 'error' || ACTIVE_DOWNLOADS.includes(j.status)).length);
  return <button className="btn queue-entry" onClick={() => useMusic.getState().setQueue(true)}>
    <Icon name="download" size={16} />下载队列
    {count > 0 && <span className="queue-badge" aria-label={`${count} 个进行中或失败的任务`}>{count}</span>}
  </button>;
}

export function DownloadQueue() {
  const open = useMusic((s) => s.queueOpen);
  const jobs = useMusic((s) => s.jobs);
  const role = useSession((s) => s.role);
  const panel = useRef(null);
  useEffect(() => {
    if (!open || role !== 'host') return;
    const previous = document.activeElement;
    panel.current?.querySelector('[aria-label="关闭下载队列"]')?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); useMusic.getState().setQueue(false); }
      if (e.key !== 'Tab') return;
      const buttons = [...panel.current.querySelectorAll('button:not(:disabled)')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus(); };
  }, [open, role]);
  if (!open || role !== 'host') return null;
  const list = Object.values(jobs).sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
  const music = useMusic.getState();
  return <>
    <div className="scrim queue-scrim" onClick={() => music.setQueue(false)} />
    <aside ref={panel} className="drawer download-drawer" role="dialog" aria-modal="true" aria-label="下载队列">
      <div className="panel-head">
        <h2>下载队列 <span className="muted">{list.length}</span></h2>
        <button className="btn ghost" disabled={!list.some((j) => j.status === 'done')} onClick={music.clearCompleted}>清除已完成</button>
        <button className="icon-btn" aria-label="关闭下载队列" onClick={() => music.setQueue(false)}><Icon name="close" /></button>
      </div>
      <div className="drawer-body download-list">
        {!list.length && <div className="empty">还没有下载任务，搜索歌曲后点击下载</div>}
        {list.map((j) => {
          const percent = Math.max(0, Math.min(100, Math.round((j.progress || 0) * 100)));
          return <article className={`download-item ${j.status}`} key={j.id}>
            <span className="thumb">{j.cover ? <img src={j.cover} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="music" />}</span>
            <div className="download-info">
              <div className="item-title" title={j.title}>{j.title}</div>
              <div className="muted">{j.artist || '未知歌手'} · {(j.format || 'original').toUpperCase()}</div>
              <span className={`tag ${j.status === 'error' ? 'err' : j.status === 'done' ? 'ok' : 'info'}`}>{STATUS[j.status]}{j.status === 'downloading' ? ` ${percent}%` : ''}</span>
              {j.status === 'downloading' && <div className="bar" role="progressbar" aria-label={`${j.title} 下载进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></div>}
              {j.status === 'error' && <div className="download-error">{j.error || '下载未完成，请重试'}</div>}
              {j.status === 'done' && j.note && <div className="muted">{j.note}</div>}
              {j.status === 'error' && <button className="btn" onClick={() => music.download(j.trackId, { jobId: j.id })}><Icon name="download" size={14} />重新下载</button>}
            </div>
            <button className="icon-btn" aria-label={`移除记录（不取消下载）：${j.title}`} title="仅从队列移除，不取消下载" onClick={() => music.removeJob(j.id)}><Icon name="trash" size={16} /></button>
          </article>;
        })}
      </div>
      <AudioUnlock />
    </aside>
  </>;
}
