// 原生 RTCPeerConnection 封装。Host 永远是 offerer，因此不需要 perfect negotiation。
// 两条 DataChannel：
//   ctrl - 控制指令 + 时钟同步（小消息，JSON）
//   file - 音频文件分片（二进制），与 ctrl 分开避免大块数据阻塞控制指令
//
// 稳定性处理：
//   - ICE 服务器由服务端下发（server/ice.js），可配 TURN
//   - 'disconnected' 持续 3s 或 'failed' → Host 发起 ICE restart（重新协商，不重建通道）
//   - 记录收集到的候选类型（host / srflx / relay），连接后读取选中的候选对，供调试面板与故障诊断
const FALLBACK_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const RESTART_AFTER_DISCONNECT_MS = 3000;
const MAX_RESTARTS = 3;

/** forceRelay：只用 TURN 中继（测试 TURN 是否可用，对应 URL 参数 ?relay=1） */
export function createPeer({ isHost, iceServers, forceRelay, sendSignal, onChannel, onState, onIce }) {
  const pc = new RTCPeerConnection({
    iceServers: iceServers?.length ? iceServers : FALLBACK_ICE,
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
  });
  const pendingCandidates = [];
  const gathered = { host: 0, srflx: 0, prflx: 0, relay: 0, mdns: 0 };
  let restarts = 0;
  let disconnectTimer = null;

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const c = e.candidate;
      gathered[c.type] = (gathered[c.type] || 0) + 1;
      if (c.address?.endsWith('.local')) gathered.mdns++; // Chrome 用 mDNS 隐藏本机 IP
      sendSignal({ candidate: c });
    }
    onIce?.({ gathering: pc.iceGatheringState, gathered: { ...gathered } });
  };
  pc.onicegatheringstatechange = () => onIce?.({ gathering: pc.iceGatheringState, gathered: { ...gathered } });

  async function restartIce() {
    if (!isHost || restarts >= MAX_RESTARTS || pc.signalingState === 'closed') return;
    restarts++;
    console.info(`[rtc] ICE restart #${restarts}`);
    pc.restartIce();
    await pc.setLocalDescription();
    sendSignal({ sdp: pc.localDescription });
  }

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    onState(s);
    clearTimeout(disconnectTimer);
    if (s === 'connected') {
      restarts = 0;
      selectedPair(pc).then((pair) => onIce?.({ gathering: pc.iceGatheringState, gathered: { ...gathered }, pair }));
    }
    // 'disconnected' 常常会自己恢复（Wi-Fi 抖动），先等一会儿再重启 ICE
    if (s === 'disconnected') disconnectTimer = setTimeout(restartIce, RESTART_AFTER_DISCONNECT_MS);
    if (s === 'failed') restartIce();
  };

  if (isHost) {
    onChannel(pc.createDataChannel('ctrl', { ordered: true }));
    onChannel(pc.createDataChannel('file', { ordered: true }));
  } else {
    pc.ondatachannel = (e) => onChannel(e.channel);
  }

  return {
    pc,
    gathered,
    async start() {
      await pc.setLocalDescription();
      sendSignal({ sdp: pc.localDescription });
    },
    async handleSignal({ sdp, candidate }) {
      if (sdp) {
        await pc.setRemoteDescription(sdp);
        if (sdp.type === 'offer') {
          await pc.setLocalDescription();
          sendSignal({ sdp: pc.localDescription });
        }
        for (const c of pendingCandidates.splice(0)) await pc.addIceCandidate(c);
      } else if (candidate) {
        // remoteDescription 设置之前到达的 candidate 先缓存
        if (pc.remoteDescription) await pc.addIceCandidate(candidate);
        else pendingCandidates.push(candidate);
      }
    },
    /** 单条 DataChannel 消息的安全分片大小 */
    get chunkSize() {
      const max = pc.sctp?.maxMessageSize || 64 * 1024;
      return Math.min(64 * 1024, max);
    },
    selectedPair: () => selectedPair(pc),
    close() {
      clearTimeout(disconnectTimer);
      pc.close();
    },
  };
}

/** 当前选中的候选对：直连（host）/ 打洞（srflx）/ 中继（relay） */
async function selectedPair(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) stats.forEach((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && (pair = s));
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return {
      local: local && { type: local.candidateType, protocol: local.protocol, address: local.address, port: local.port },
      remote: remote && { type: remote.candidateType, protocol: remote.protocol, address: remote.address, port: remote.port },
      rtt: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
    };
  } catch {
    return null;
  }
}
