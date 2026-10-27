import { useEffect, useRef } from 'react';
import { songResults } from '../../public/playerPresentation.js';
import { engine, fmtTime } from '../engine/session.js';
import { jobForTrack, useMusic } from '../store/useMusic.js';
import { useSession } from '../store/useSession.js';
import { Icon } from './Icon.jsx';
import { AudioUnlock } from './AudioUnlock.jsx';
import { DownloadQueueButton } from './DownloadQueue.jsx';

const VERSION_TONE = { original: '', variant: '', live: '', unknown: '', cover: '', other: '' };
const ACTIVE = ['queued', 'downloading', 'processing'];
const STATUS = { queued: '排队中', downloading: '下载中', processing: '处理中', done: '完成', error: '失败' };

const plays = (n) => (n == null ? '' : n >= 1e8 ? `${(n / 1e8).toFixed(1)}亿` : n >= 1e4 ? `${Math.round(n / 1e4)}万` : String(n));

/** 音质标签：FLAC / 320k / M4A ≈128k */
function qualityLabel(t) {
  const fmt = (t.format || '').toUpperCase();
  if (fmt === 'FLAC') return 'FLAC';
  if (t.bitrate >= 320 && !t.bitrateEstimated) return '320k';
  if (t.bitrate) return `${fmt || 'AAC'} ${t.bitrateEstimated ? '≈' : ''}${t.bitrate}k`;
  return fmt || null;
}

function DownloadButton({ track }) {
  const playlist = useSession(s => s.playlist);
  const job = useMusic((s) => jobForTrack(s.jobs, track.id));
  const inLibrary = useMusic((s) => s.library.find((e) => e.trackId === track.id));
  const download = useMusic((s) => s.download);

  if (job && ACTIVE.includes(job.status)) {
    return (
      <div className="dl-progress" aria-live="polite">
        <div className="bar">
          <i style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
        </div>
        {job.status === 'downloading' ? `${Math.round((job.progress || 0) * 100)}%` : STATUS[job.status]}
      </div>
    );
  }
  if (inLibrary || job?.status === 'done') {
    const file = inLibrary?.file || job?.file;
    const inRoom = playlist.some(item => item.id === `lib:${file}`);
    return <button className="btn dl-btn" disabled={inRoom || !inLibrary || !file} onClick={() => {
      engine.syncLibrary(useMusic.getState().library, [file]);
    }} title="追加到共享列表，不打断当前播放">{inRoom ? '已在房间' : '追加到房间'}</button>;
  }
  return (
    <button className="btn dl-btn" onClick={() => download(track.id)} title={job?.status === 'error' ? `上次失败：${job.error}` : '下载到本机曲库'}>
      <Icon name="download" size={15} />
      {job?.status === 'error' ? '重试下载' : '下载到曲库'}
    </button>
  );
}

function ResultItem({ t }) {
  const quality = qualityLabel(t);
  return (
    <div className="result">
      <span className="thumb">{t.cover ? <img src={t.cover} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="music" size={20} />}</span>
      <div className="result-meta">
        {t.pageUrl ? (
          <a className="result-title" href={t.pageUrl} target="_blank" rel="noopener noreferrer" title={`在 ${t.sourceName} 打开，核对版本`}>
            {t.title} <Icon name="external" size={12} className="external-icon" />
          </a>
        ) : (
          <span className="result-title">{t.title}</span>
        )}
        <div className="result-sub">
          {[t.artist, t.uploader && t.uploader !== t.artist && (t.source === 'bilibili' ? `UP ${t.uploader}` : t.uploader), t.album, fmtTime(t.duration), t.plays != null && `${plays(t.plays)}播放`]
            .filter(Boolean)
            .join(' · ')}
        </div>
        <div className="result-tags">
          <span className={`tag ${VERSION_TONE[t.version] || ''}`}>{t.versionLabel}</span>
          <span className="tag">{t.sourceName}</span>
          {quality && <span className="tag quality">{quality}</span>}
          {t.trusted && <span className="tag host">收藏UP</span>}
          {t.category && t.source === 'bilibili' && <span className="tag">{t.category}</span>}
        </div>
      </div>
      <DownloadButton track={t} />
    </div>
  );
}

function ServiceDown() {
  const init = useMusic((s) => s.init);
  return (
    <div className="service-down">
      <b>音乐服务未启动</b>
      <span>搜索下载由本机的 music-service 提供，在新终端运行：</span>
      <code>cd music-service &amp;&amp; npm start</code>
      <button className="btn service-retry" onClick={init}>
        重新检测
      </button>
    </div>
  );
}

export function SearchDrawer() {
  const open = useMusic((s) => s.drawerOpen);
  const music = useMusic();
  const role = useSession((s) => s.role);
  const input = useRef(null);
  const panel = useRef(null);

  useEffect(() => {
    if (!open || role !== 'host') return;
    const previous = document.activeElement;
    (input.current || panel.current?.querySelector('button:not(:disabled)'))?.focus();
    const onKey = (e) => {
      if (useMusic.getState().queueOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); music.setDrawer(false); }
      if (e.key !== 'Tab') return;
      const controls = [...panel.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')];
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, role]);

  if (!open || role !== 'host') return null;
  const { result, health } = music;
  const providers = health?.providers ?? [];
  const selected = music.sources.length ? music.sources : providers.map((p) => p.name);
  const counts = result?.counts;
  const { best, groups } = songResults(result?.results || [], music.query);

  return (
    <>
      <div className="scrim" onClick={() => music.setDrawer(false)} />
      <aside ref={panel} className="drawer" role="dialog" aria-modal={!music.queueOpen ? 'true' : undefined} inert={music.queueOpen ? '' : undefined} aria-label="搜索与下载">
        <div className="panel-head">
          <h2>搜索与下载</h2>
          <DownloadQueueButton />
          <button className="icon-btn" aria-label="关闭" onClick={() => music.setDrawer(false)}>
            <Icon name="close" />
          </button>
        </div>

        <div className="drawer-body">
          {music.available === false ? (
            <ServiceDown />
          ) : (
            <>
              <label className="search-label" htmlFor="music-search">搜索音乐</label>
              <form
                className="search-form" aria-busy={music.searching}
                onSubmit={(e) => {
                  e.preventDefault();
                  music.search();
                }}
              >
                <input id="music-search" ref={input} className="input" placeholder="歌名，可加歌手：晴天 周杰伦" value={music.query} onChange={(e) => music.setQuery(e.target.value)} />
                <button className="btn primary" disabled={music.searching || !music.query.trim()}>
                  {music.searching ? '搜索中…' : '搜索'}
                </button>
              </form>

              <div className="filter-row" role="group" aria-label="音源">
                {providers.map((p) => (
                  <button key={p.name} className="chip" aria-pressed={selected.includes(p.name)} onClick={() => music.toggleSource(p.name)}>
                    {p.label}
                  </button>
                ))}
                <span className="spacer" />
                <span className="seg" role="group" aria-label="版本筛选">
                  <button aria-pressed={music.versions === 'original'} onClick={() => music.setVersions('original')}>
                    只看原版{counts ? ` ${counts.original}` : ''}
                  </button>
                  <button aria-pressed={music.versions === 'all'} onClick={() => music.setVersions('all')}>
                    全部{counts ? ` ${Object.values(counts).reduce((a, b) => a + b, 0)}` : ''}
                  </button>
                </span>
                <select className="input" value={music.format} onChange={(e) => music.setFormat(e.target.value)} aria-label="下载格式">
                  <option value="mp3" disabled={!health?.ffmpeg}>
                    MP3{health?.ffmpeg ? '' : '（需 ffmpeg）'}
                  </option>
                  <option value="m4a">M4A</option>
                  <option value="original">原始格式</option>
                </select>
              </div>

              {music.searching && <p role="status">{result ? '正在刷新，保留本次查询结果…' : '正在搜索…'}</p>}
              <p className="muted">先下载到曲库，再追加到共享房间；不会替换当前歌曲。</p>
              {music.error && <div className="tag err search-error">{music.error}</div>}

              {result && (
                <>
                  <div className="originals-line">
                    {result.originals.length ? (
                      <>
                        原唱识别：
                        {result.originals.map((o, i) => (
                          <span key={o.artist}>
                            {i > 0 && '、'}
                            <b>{o.artist}</b>
                            {o.plays ? `（${plays(o.plays)}次播放）` : ''}
                          </span>
                        ))}
                      </>
                    ) : (
                      '未能识别原唱，显示全部非翻唱结果，请点击标题核对版本'
                    )}
                  </div>
                  <div className="source-status">
                    {result.sources.map((s) => (
                      <span key={s.source} className={`tag ${s.ok ? '' : 'err'}`} title={s.error || ''}>
                        {s.label} {s.ok ? `${s.originals}/${s.count}` : s.code} · {s.ms}ms
                      </span>
                    ))}
                  </div>
                  <div className="search-results">
                    {best && <section className="best-result"><h3>最佳匹配</h3><ResultItem t={best} /></section>}
                    {groups.map(group => <section key={group.key}><h3>{group.label} · {group.tracks.length} 首</h3>{group.tracks.map(t => <ResultItem key={t.id} t={t} />)}</section>)}
                    {!result.results.length && (
                      <div className="empty">
                        没有{music.versions === 'original' ? '原版' : ''}结果
                        {result.hidden ? `，另有 ${result.hidden} 条其他版本，切换到"全部"查看` : ''}
                      </div>
                    )}
                  </div>
                </>
              )}
              {!result && !music.searching && <div className="empty">搜索 YouTube Music 官方音源、B 站 UP 主搬运、YouTube 官方 MV，默认只显示歌手原版。</div>}
            </>
          )}
        </div>
        {!music.queueOpen && <AudioUnlock />}
      </aside>
    </>
  );
}
