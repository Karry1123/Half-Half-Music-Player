import { useEffect, useState } from 'react';
import { engine } from '../engine/session.js';
import { useSession } from '../store/useSession.js';

const ms = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : `${Number(v).toFixed(d)} ms`);
const PAIR_LABEL = { host: '局域网直连', srflx: 'STUN 打洞', prflx: '打洞（对端反射）', relay: 'TURN 中继' };
const ZONE = { ok: '同步良好', soft: '微调速率', strong: '最大速率追赶', seek: '硬跳转' };

/** 漂移折线：±60ms 区间，红线为死区边界（±15ms） */
function Sparkline({ values }) {
  const w = 240;
  const h = 56;
  const range = 60;
  const y = (v) => h / 2 - (Math.max(-range, Math.min(range, v)) / range) * (h / 2 - 2);
  const pts = values.map((v, i) => `${(i / 59) * w},${y(v)}`).join(' ');
  return (
    <svg width={w} height={h} className="spark" aria-label="漂移曲线">
      <line x1="0" x2={w} y1={h / 2} y2={h / 2} className="axis" />
      <line x1="0" x2={w} y1={y(15)} y2={y(15)} className="limit" />
      <line x1="0" x2={w} y1={y(-15)} y2={y(-15)} className="limit" />
      {values.length > 1 && <polyline points={pts} className="line" />}
    </svg>
  );
}

function Row({ k, children }) {
  return (
    <div className="dbg-row">
      <span>{k}</span>
      <b>{children}</b>
    </div>
  );
}

/** ?debug=1 打开。所有数据直接从 engine 读取，500ms 刷新 */
export function DebugPanel() {
  const role = useSession((s) => s.role);
  const [info, setInfo] = useState(() => engine.debugInfo());
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setInfo(engine.debugInfo()), 500);
    return () => clearInterval(t);
  }, []);

  if (!open) {
    return (
      <button className="dbg-toggle" onClick={() => setOpen(true)}>
        调试
      </button>
    );
  }
  const g = info.ice?.gathered || {};
  const pair = info.ice?.pair;
  const copy = () => navigator.clipboard?.writeText(JSON.stringify(info, null, 2)).catch(() => {});

  return (
    <aside className="dbg" aria-label="调试面板">
      <div className="dbg-head">
        <b>调试 · {role}</b>
        <span className="spacer" />
        <button onClick={copy}>复制诊断</button>
        <button onClick={() => setOpen(false)}>收起</button>
      </div>

      <section>
        <h4>连接</h4>
        <Row k="P2P">{info.peerState}</Row>
        <Row k="ICE 收集">
          {info.ice?.gathering || '–'} · host {g.host || 0}
          {g.mdns ? `(mDNS ${g.mdns})` : ''} / srflx {g.srflx || 0} / relay {g.relay || 0}
        </Row>
        <Row k="选中路径">{pair ? `${PAIR_LABEL[pair.local?.type] || pair.local?.type} · ${pair.local?.protocol} · ${ms(pair.rtt)}` : '–'}</Row>
        {pair && (
          <Row k="地址">
            {pair.local?.address || '?'} ⇄ {pair.remote?.address || '?'}
          </Row>
        )}
        <Row k="STUN/TURN">{(info.iceServers || []).flatMap((s) => [].concat(s.urls)).length} 个</Row>
      </section>

      <section>
        <h4>时钟同步</h4>
        <Row k="RTT / 偏移">
          {ms(info.clock.rtt)} / {ms(info.clock.offset)}
        </Row>
        <Row k="样本">{info.clock.samples}</Row>
        <Row k="指令提前量">{ms(info.leadMs, 0)}</Row>
      </section>

      <section>
        <h4>播放</h4>
        <Row k="播放器">
          {info.player.kind === 'stream' ? 'StreamPlayer（边收边播）' : 'BufferPlayer（整首解码）'}
          {info.format ? ` · ${info.format.container}` : ''}
        </Row>
        <Row k="AudioContext">
          {info.audio.state} · 输出延迟 {ms(info.audio.outputLatency * 1000, 0)}
        </Row>
        <Row k="速率">
          {info.player.rate?.toFixed(4)} {info.sync ? `· ${ZONE[info.sync.zone]}` : ''}
        </Row>
        {info.player.kind === 'stream' && (
          <Row k="缓冲">
            领先 {info.player.bufferedAhead ?? 0}s{info.player.stalled ? ' · 卡顿' : ''}
            {info.player.complete ? ' · 已收完' : ''}
          </Row>
        )}
        {role === 'guest' && (
          <>
            <Row k="漂移">{info.sync ? ms(info.sync.drift * 1000) : '–'}</Row>
            <Sparkline values={info.driftHistory} />
          </>
        )}
      </section>

      {info.netsim && (
        <section>
          <h4>网络模拟</h4>
          <Row k="延迟/抖动">
            {info.netsim.delay} + 0~{info.netsim.jitter} ms
          </Row>
          <Row k="带宽">{info.netsim.rate ? `${Math.round(info.netsim.rate / 1024)} KB/s` : '不限'}</Row>
        </section>
      )}

      <div className="dbg-actions">
        {role === 'guest' && (
          <>
            <button onClick={() => engine.injectDrift(0.15)}>注入 +150ms</button>
            <button onClick={() => engine.injectDrift(-0.4)}>注入 −400ms</button>
            <button onClick={() => engine.injectDrift(0.9)}>注入 +900ms</button>
          </>
        )}
        {role === 'host' && <button onClick={() => engine.restartIce()}>ICE restart</button>}
      </div>
    </aside>
  );
}
