import { useEffect, useRef } from 'react';
import { engine, fmtTime } from '../engine/session.js';
import { jobForTrack, useMusic } from '../store/useMusic.js';
import { useSession } from '../store/useSession.js';
import { Icon } from './Icon.jsx';

const VERSION_TONE = { original: 'ok', variant: 'guest', live: 'guest', unknown: 'warn', cover: 'err', other: 'err' };
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
    return (
      <button className="btn dl-btn" onClick={() => engine.act('select', { itemId: `lib:${file}` })} title="已在播放列表中，点击播放">
        <Icon name="play" size={14} />
        播放
      </button>
    );
  }
  return (
    <button className="btn dl-btn" onClick={() => download(track.id)} title={job?.status === 'error' ? `上次失败：${job.error}` : '下载到本机曲库'}>
      <Icon name="download" size={15} />
      {job?.status === 'error' ? '重试' : '下载'}
    </button>
  );
}

function ResultItem({ t }) {
  const quality = qualityLabel(t);
  return (
    <div className="result">
      <span className="thumb">{t.cover ? <img src={t.cover} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="music" size={20} />}</span>
      <div style={{ minWidth: 0 }}>
        {t.pageUrl ? (
          <a className="result-title" href={t.pageUrl} target="_blank" rel="noopener noreferrer" title={`在 ${t.sourceName} 打开，核对版本`}>
            {t.title} <Icon name="external" size={12} style={{ verticalAlign: '-1px', opacity: 0.6 }} />
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

function DownloadQueue() {
  const jobs = useMusic((s) => s.jobs);
  const list = Object.values(jobs)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8);
  if (!list.length) return null;
  return (
    <div className="queue" aria-label="下载任务">
      <span className="muted" style={{ fontSize: 12 }}>
        下载任务
      </span>
      {list.map((j) => (
        <div className="queue-item" key={j.id}>
          <div className="row">
            <span className="name">
              {j.artist ? `${j.artist} - ` : ''}
              {j.title}
            </span>
            <span className={j.status === 'error' ? 'tag err' : j.status === 'done' ? 'tag ok' : 'muted'}>
              {j.status === 'downloading' ? `${Math.round(j.progress * 100)}%` : STATUS[j.status]}
            </span>
          </div>
          {ACTIVE.includes(j.status) && (
            <div className="bar">
              <i style={{ width: `${Math.round((j.progress || 0) * 100)}%` }} />
            </div>
          )}
          {j.error && <span style={{ color: 'var(--err)' }}>{j.error}</span>}
          {j.note && j.status === 'done' && <span className="muted">{j.note}</span>}
        </div>
      ))}
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
      <button className="btn" style={{ justifySelf: 'start' }} onClick={init}>
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

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e) => e.key === 'Escape' && music.setDrawer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open || role !== 'host') return null;
  const { result, health } = music;
  const providers = health?.providers ?? [];
  const selected = music.sources.length ? music.sources : providers.map((p) => p.name);
  const counts = result?.counts;

  return (
    <>
      <div className="scrim" onClick={() => music.setDrawer(false)} />
      <aside className="drawer" role="dialog" aria-label="搜索与下载">
        <div className="panel-head">
          <h2>搜索与下载</h2>
          <button className="icon-btn" aria-label="关闭" onClick={() => music.setDrawer(false)}>
            <Icon name="close" />
          </button>
        </div>

        <div className="drawer-body">
          {music.available === false ? (
            <ServiceDown />
          ) : (
            <>
              <form
                className="search-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  music.search();
                }}
              >
                <input ref={input} className="input" placeholder="歌名，可加歌手：晴天 周杰伦" value={music.query} onChange={(e) => music.setQuery(e.target.value)} />
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
                <span style={{ flex: 1 }} />
                <span className="seg" role="group" aria-label="版本筛选">
                  <button aria-pressed={music.versions === 'original'} onClick={() => music.setVersions('original')}>
                    只看原版{counts ? ` ${counts.original}` : ''}
                  </button>
                  <button aria-pressed={music.versions === 'all'} onClick={() => music.setVersions('all')}>
                    全部{counts ? ` ${Object.values(counts).reduce((a, b) => a + b, 0)}` : ''}
                  </button>
                </span>
                <select className="input" style={{ height: 30, fontSize: 12 }} value={music.format} onChange={(e) => music.setFormat(e.target.value)} aria-label="下载格式">
                  <option value="mp3" disabled={!health?.ffmpeg}>
                    MP3{health?.ffmpeg ? '' : '（需 ffmpeg）'}
                  </option>
                  <option value="m4a">M4A</option>
                  <option value="original">原始格式</option>
                </select>
              </div>

              {music.error && <div className="tag err" style={{ height: 'auto', padding: '6px 10px' }}>{music.error}</div>}

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
                  <div style={{ display: 'grid', gap: 2 }}>
                    {result.results.map((t) => (
                      <ResultItem key={t.id} t={t} />
                    ))}
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
        <DownloadQueue />
      </aside>
    </>
  );
}
