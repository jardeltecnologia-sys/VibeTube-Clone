// SpeedVox 1:1 voice & video calls over WebRTC.
// The Socket.IO server only relays signaling (SDP/ICE); audio and video flow
// directly peer-to-peer. The module owns its own full-screen call UI.

import { mediaConstraints, tuneAudioSdp, capVideoBitrate } from './webrtc-quality.js';
import * as ringtone from './ringtone.js';
import { buildCallSignal, routeCallSignal } from '/mesh-core/callsignal.js';

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

// How long to wait for ICE to connect before giving up.
const ICE_TIMEOUT_MS = 30000;
// How long to wait after 'disconnected'/'failed' before closing the call.
const GRACE_MS = 20000;
// Max ICE restarts before giving up.
const MAX_ICE_RESTARTS = 3;

export class CallManager {
  constructor({ socket, selfId, iceServers, mesh = null, self = null }) {
    this.socket = socket;
    this.selfId = selfId;
    // Optional mesh transport: lets calls be signaled with NO server (blackout),
    // and `self` is our public profile so the callee can show who's calling.
    this.mesh = mesh;
    this.self = self;
    this.iceServers = iceServers && iceServers.length ? iceServers : DEFAULT_ICE;
    this.pc = null;
    this.localStream = null;
    this.callId = null;
    this.peer = null;        // { id, displayName, avatarUrl }
    this.media = 'audio';    // 'audio' | 'video'
    this.role = null;        // 'caller' | 'callee'
    this.pendingIce = [];
    this.timer = null;
    this.startedAt = 0;
    this.graceTimer = null;
    this.iceTimer = null;    // Connection-establishment timeout
    this.iceRestarts = 0;
    this._bindSignals();
    this._buildUI();
  }

  // ---------------------------------------------------------------- signaling
  _bindSignals() {
    const s = this.socket;
    s.on('call:incoming', (d) => this._onIncoming(d));
    s.on('call:accepted', (d) => this._onAccepted(d));
    s.on('call:rejected', (d) => this._onRejected(d));
    s.on('call:unavailable', (d) => this._onUnavailable(d));
    s.on('call:sdp', (d) => this._onSdp(d));
    s.on('call:ice', (d) => this._onIce(d));
    s.on('call:ended', (d) => this._onEnded(d));
    s.on('call:watchparty', (d) => this._onWatchParty(d));
  }

  // Send a call signal. When the server is reachable, behaves EXACTLY like
  // before (socket.emit, same payload). When it isn't, the same signal goes over
  // the mesh so the call can still be set up peer-to-peer in a blackout.
  // `meshType` is the compact mesh signal type (invite/accept/reject/sdp/ice/end).
  _send(socketEvent, meshType, payload, meshExtra = {}) {
    if (this.socket && this.socket.connected) {
      this.socket.emit(socketEvent, payload);
      return;
    }
    if (this.mesh && this.mesh.enabled && this.peer) {
      const sig = buildCallSignal(meshType, {
        callId: this.callId,
        media: payload.media,
        sdp: payload.sdp,
        candidate: payload.candidate,
        from: meshExtra.from,
      });
      this.mesh.sendCallSignal(this.peer.id, sig);
    }
  }

  // A call signal arrived over the mesh (server-free path). Route it to the same
  // handler the Socket.IO event would have hit.
  onMeshSignal({ from, signal }) {
    const routed = routeCallSignal(signal, from);
    if (!routed) return;
    const fn = this[routed.handler];
    if (typeof fn === 'function') fn.call(this, routed.payload);
  }

  async _ensureMedia() {
    if (this.localStream) return this.localStream;
    let stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(this.media));

    const noiseSuppression = localStorage.getItem('speedvox_noise_suppression') === '1';
    const audioTrack = stream.getAudioTracks()[0];
    if (noiseSuppression && audioTrack) {
      try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);

        const filter = audioCtx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 85;

        const gate = audioCtx.createDynamicsCompressor();
        gate.threshold.value = -45;
        gate.knee.value = 5;
        gate.ratio.value = 18;
        gate.attack.value = 0.005;
        gate.release.value = 0.15;

        const dest = audioCtx.createMediaStreamDestination();

        source.connect(filter);
        filter.connect(gate);
        gate.connect(dest);

        const cleanAudioTrack = dest.stream.getAudioTracks()[0];
        const tracks = [cleanAudioTrack];
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) tracks.push(videoTrack);

        this.noiseAudioContext = audioCtx;
        stream = new MediaStream(tracks);
      } catch (err) {
        console.warn('Falha ao inicializar Limpeza de Ruído via Web Audio:', err);
      }
    }

    this.localStream = stream;
    this.localVideo.srcObject = this.localStream;
    return this.localStream;
  }

  _createPeer() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 4 });
    this.pc = pc;
    this.iceRestarts = 0;
    this._startIceTimeout();

    for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this._send('call:ice', 'ice', { to: this.peer.id, callId: this.callId, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      this.remoteVideo.srcObject = e.streams[0];
      this._setStatus(this.media === 'video' ? '' : 'Em chamada');
    };

    // Watch both state properties — they update at slightly different times
    // across browsers. Using both gives us the earliest signal.
    pc.onconnectionstatechange = () => this._onConnState(pc);
    pc.oniceconnectionstatechange = () => this._onIceState(pc);

    return pc;
  }

  // ---------- connection state (high-level: new/connecting/connected/failed/closed) ----------
  _onConnState(pc) {
    // Guard: ignore events that arrive after this PC was replaced or cleared.
    if (pc !== this.pc) return;
    const st = pc.connectionState;
    if (!st) return;

    if (st === 'connected') {
      this._onConnected();
    } else if (st === 'failed') {
      this._onFailed();
    } else if (st === 'disconnected') {
      this._setStatus('Reconectando…');
      this._startGrace();
    } else if (st === 'closed') {
      this._onClosed();
    }
  }

  // ---------- ICE state (lower-level: checking/connected/completed/failed/disconnected) -------
  _onIceState(pc) {
    if (pc !== this.pc) return;
    const st = pc.iceConnectionState;
    if (!st) return;

    if (st === 'connected' || st === 'completed') {
      this._onConnected();
    } else if (st === 'failed') {
      this._onFailed();
    } else if (st === 'disconnected') {
      this._setStatus('Reconectando…');
      this._startGrace();
    } else if (st === 'closed') {
      this._onClosed();
    }
  }

  _onConnected() {
    this._clearGrace();
    this._clearIceTimeout();
    if (this.iceRestarts > 0) this.iceRestarts = 0;
    this._startTimer();
    this._setStatus(this.media === 'video' ? '' : 'Em chamada');
  }

  _onFailed() {
    this._setStatus('Reconectando…');
    this._tryIceRestart();
    this._startGrace();
  }

  // Only called when the PC itself is closed (not from _reset — that guards against this).
  _onClosed() {
    if (this.callId) this.hangup(true);
  }

  // ---------------------------------------------------------------- grace / timers
  _startGrace() {
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (!this.pc) return;
      const connSt = this.pc.connectionState;
      const iceSt = this.pc.iceConnectionState;
      const ok = connSt === 'connected' || iceSt === 'connected' || iceSt === 'completed';
      if (!ok) this.hangup(true);
    }, GRACE_MS);
  }

  _clearGrace() {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
  }

  // Watchdog: if ICE never reaches 'connected' after creating the peer, give up.
  _startIceTimeout() {
    this._clearIceTimeout();
    this.iceTimer = setTimeout(() => {
      this.iceTimer = null;
      if (!this.pc) return;
      const connSt = this.pc.connectionState;
      const iceSt = this.pc.iceConnectionState;
      const ok = connSt === 'connected' || iceSt === 'connected' || iceSt === 'completed';
      if (!ok) {
        this._toast('Não foi possível conectar. Verifique sua conexão.');
        this.hangup(true);
      }
    }, ICE_TIMEOUT_MS);
  }

  _clearIceTimeout() {
    if (this.iceTimer) { clearTimeout(this.iceTimer); this.iceTimer = null; }
  }

  // ICE restart: both sides can initiate. Caller sends new offer with iceRestart,
  // callee responds. If callee triggers this it sends a re-invite signal so the
  // caller knows to re-offer.
  async _tryIceRestart() {
    const pc = this.pc;
    if (!pc || this.iceRestarts >= MAX_ICE_RESTARTS) return;
    this.iceRestarts += 1;
    if (this.role === 'caller') {
      try {
        const offer = await pc.createOffer({ iceRestart: true });
        offer.sdp = tuneAudioSdp(offer.sdp);
        await pc.setLocalDescription(offer);
        this._send('call:sdp', 'sdp', { to: this.peer.id, callId: this.callId, sdp: pc.localDescription });
      } catch { /* grace timer will handle cleanup */ }
    }
    // Callee: caller will detect the failure too and re-offer via its own _onFailed.
    // No action needed on the callee side.
  }

  // ---------------------------------------------------------------- outgoing
  async startCall(peer, media = 'audio') {
    if (this.callId) return;
    this.peer = peer;
    this.media = media;
    this.role = 'caller';
    this.callId = `${this.selfId}-${Date.now()}`;
    try {
      await this._ensureMedia();
    } catch {
      this._toast('Não foi possível acessar microfone/câmera');
      this._reset();
      return;
    }
    this._showOverlay('outgoing');
    this._setStatus('Chamando…');
    ringtone.startOutgoing();
    this._send('call:invite', 'invite', { to: peer.id, callId: this.callId, media }, { from: this.self });
  }

  async _onAccepted({ callId }) {
    if (callId !== this.callId || this.role !== 'caller') return;
    ringtone.stop();
    const pc = this._createPeer();
    try {
      const offer = await pc.createOffer();
      offer.sdp = tuneAudioSdp(offer.sdp);
      await pc.setLocalDescription(offer);
      if (this.media === 'video') capVideoBitrate(pc);
      this._send('call:sdp', 'sdp', { to: this.peer.id, callId: this.callId, sdp: pc.localDescription });
      this._setStatus('Conectando…');
    } catch {
      this._toast('Erro ao iniciar chamada');
      this.hangup();
    }
  }

  _onRejected({ callId }) {
    if (callId !== this.callId) return;
    this._toast('Chamada recusada');
    this.hangup(true);
  }

  _onUnavailable({ callId }) {
    if (callId !== this.callId) return;
    this._toast('Usuário indisponível');
    this.hangup(true);
  }

  // ---------------------------------------------------------------- incoming
  _onIncoming({ from, callId, media }) {
    if (this.callId) {
      // Busy: reject straight away (this.peer isn't ours here, so signal `from`).
      if (this.socket && this.socket.connected) {
        this.socket.emit('call:reject', { to: from.id, callId });
      } else if (this.mesh && this.mesh.enabled) {
        this.mesh.sendCallSignal(from.id, buildCallSignal('reject', { callId }));
      }
      return;
    }
    this.peer = from;
    this.callId = callId;
    this.media = media;
    this.role = 'callee';
    this._showOverlay('incoming');
    this._setStatus(media === 'video' ? 'Chamada de vídeo recebida' : 'Chamada recebida');
    ringtone.startIncoming();

    if (window.state && window.state.pendingAnswerCallId === callId) {
      window.state.pendingAnswerCallId = null;
      this._accept();
    }
  }

  async _accept() {
    ringtone.stop();
    try {
      await this._ensureMedia();
    } catch {
      this._toast('Não foi possível acessar microfone/câmera');
      this._reject();
      return;
    }
    this._createPeer();
    this._send('call:accept', 'accept', { to: this.peer.id, callId: this.callId });
    this._showOverlay('active');
    this._setStatus('Conectando…');
  }

  _reject() {
    this._send('call:reject', 'reject', { to: this.peer.id, callId: this.callId });
    this._reset();
  }

  // ---------------------------------------------------------------- sdp / ice
  async _onSdp({ callId, sdp }) {
    if (callId !== this.callId || !this.pc) return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      for (const c of this.pendingIce.splice(0)) {
        try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
      }
      if (sdp.type === 'offer') {
        const answer = await this.pc.createAnswer();
        answer.sdp = tuneAudioSdp(answer.sdp);
        await this.pc.setLocalDescription(answer);
        if (this.media === 'video') capVideoBitrate(this.pc);
        this._send('call:sdp', 'sdp', { to: this.peer.id, callId: this.callId, sdp: this.pc.localDescription });
        this._showOverlay('active');
        this._setStatus('Conectando…');
      }
    } catch (err) {
      console.error('[SpeedVox] SDP error:', err);
    }
  }

  async _onIce({ callId, candidate }) {
    if (callId !== this.callId) return;
    if (!this.pc || !this.pc.remoteDescription) { this.pendingIce.push(candidate); return; }
    try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  }

  _onEnded({ callId }) {
    if (callId !== this.callId) return;
    this.hangup(true);
  }

  // ---------------------------------------------------------------- teardown
  hangup(remote = false) {
    if (!remote && this.callId && this.peer) {
      this._send('call:end', 'end', { to: this.peer.id, callId: this.callId });
    }
    this._reset();
  }

  _reset() {
    ringtone.stop();
    this._clearGrace();
    this._clearIceTimeout();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.pc) {
      // Null BEFORE close() so that onconnectionstatechange → _onConnState / _onClosed
      // does NOT re-enter hangup() / _reset() while we are tearing down.
      const pc = this.pc;
      this.pc = null;
      try { pc.close(); } catch {}
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.noiseAudioContext) {
      try { this.noiseAudioContext.close(); } catch {}
      this.noiseAudioContext = null;
    }
    this._stopWatchParty(false);
    this.pendingIce = [];
    this.callId = null;
    this.peer = null;
    this.role = null;
    this.startedAt = 0;
    this.iceRestarts = 0;
    this.overlay.classList.add('hidden');
    this.remoteVideo.srcObject = null;
    this.localVideo.srcObject = null;
  }

  _startTimer() {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      const s = Math.floor((Date.now() - this.startedAt) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      this._setStatus(`${mm}:${ss}`);
    }, 1000);
  }

  // ---------------------------------------------------------------- UI
  _buildUI() {
    const o = document.createElement('div');
    o.className = 'call-overlay hidden';
    o.innerHTML = `
      <video class="call-remote" autoplay playsinline></video>
      <video class="call-local" autoplay playsinline muted></video>
      <div class="call-yt-wrapper" style="display:none; width: 90%; max-width: 480px; margin: 10px auto; border-radius: 12px; overflow: hidden; background: #000; aspect-ratio: 16/9; position: relative; z-index: 10;">
        <div id="yt-player-target"></div>
      </div>
      <div class="call-info">
        <div class="call-avatar"></div>
        <div class="call-name"></div>
        <div class="call-status"></div>
      </div>
      <div class="call-controls">
        <button class="call-btn mute" title="Mudo">🎙️</button>
        <button class="call-btn cam" title="Câmera">🎥</button>
        <button class="call-btn watchparty" title="Watch Party" style="display:none;">📺</button>
        <button class="call-btn accept" title="Atender">📞</button>
        <button class="call-btn hangup" title="Encerrar">📵</button>
      </div>`;
    document.body.append(o);
    this.overlay = o;
    this.remoteVideo = o.querySelector('.call-remote');
    this.localVideo = o.querySelector('.call-local');
    this.btnMute = o.querySelector('.mute');
    this.btnCam = o.querySelector('.cam');
    this.btnWatchParty = o.querySelector('.watchparty');
    this.btnAccept = o.querySelector('.accept');
    this.btnHangup = o.querySelector('.hangup');

    this.btnAccept.onclick = () => this._accept();
    this.btnHangup.onclick = () => {
      if (this.role === 'callee' && !this.pc) this._reject();
      else this.hangup();
    };
    this.btnMute.onclick = () => {
      if (!this.localStream) return;
      const track = this.localStream.getAudioTracks()[0];
      if (track) { track.enabled = !track.enabled; this.btnMute.classList.toggle('off', !track.enabled); }
    };
    this.btnCam.onclick = () => {
      if (!this.localStream) return;
      const track = this.localStream.getVideoTracks()[0];
      if (track) { track.enabled = !track.enabled; this.btnCam.classList.toggle('off', !track.enabled); }
    };
    this.btnWatchParty.onclick = () => {
      const wrap = this.overlay.querySelector('.call-yt-wrapper');
      if (wrap.style.display === 'block') {
        if (confirm('Encerrar a Watch Party atual?')) {
          this._stopWatchParty(true);
        }
      } else {
        const url = prompt('Cole o link de um vídeo do YouTube:');
        if (!url) return;
        let videoId = '';
        const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
        const match = url.match(regExp);
        if (match && match[2].length === 11) {
          videoId = match[2];
        }
        if (videoId) {
          this._initWatchParty(videoId, true);
          this._sendWatchPartyEvent({ action: 'start', videoId });
        } else {
          alert('Link do YouTube inválido.');
        }
      }
    };
  }

  _showOverlay(phase) {
    this.overlay.classList.remove('hidden');
    this.overlay.classList.toggle('video-call', this.media === 'video');
    const avatar = this.overlay.querySelector('.call-avatar');
    if (this.peer.avatarUrl) {
      avatar.style.backgroundImage = `url(${this.peer.avatarUrl})`;
      avatar.textContent = '';
    } else {
      avatar.style.backgroundImage = 'none';
      avatar.textContent = (this.peer.displayName || '?').slice(0, 2).toUpperCase();
    }
    this.overlay.querySelector('.call-name').textContent = this.peer.displayName || '';
    this.btnAccept.style.display = phase === 'incoming' ? '' : 'none';
    this.btnCam.style.display = this.media === 'video' ? '' : 'none';
    this.btnWatchParty.style.display = phase === 'active' ? '' : 'none';
  }

  _setStatus(text) {
    this.overlay.querySelector('.call-status').textContent = text;
  }

  _toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  _initWatchParty(videoId, isInitiator) {
    const wrap = this.overlay.querySelector('.call-yt-wrapper');
    wrap.style.display = 'block';

    const loadYT = () => {
      if (this.ytPlayer) {
        this.ytPlayer.loadVideoById(videoId);
        return;
      }
      const div = document.createElement('div');
      div.id = 'yt-player-target';
      wrap.innerHTML = '';
      wrap.appendChild(div);

      this.ytPlayer = new YT.Player('yt-player-target', {
        height: '100%',
        width: '100%',
        videoId: videoId,
        playerVars: {
          autoplay: 1,
          controls: isInitiator ? 1 : 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0
        },
        events: {
          onReady: (e) => {
            e.target.playVideo();
            this._startAudioDucking();
          },
          onStateChange: (e) => {
            if (!isInitiator) return;
            if (e.data === YT.PlayerState.PLAYING) {
              this._sendWatchPartyEvent({ action: 'play' });
            } else if (e.data === YT.PlayerState.PAUSED) {
              this._sendWatchPartyEvent({ action: 'pause', time: e.target.getCurrentTime() });
            }
          }
        }
      });
    };

    if (window.YT && window.YT.Player) {
      loadYT();
    } else {
      window.onYouTubeIframeAPIReady = loadYT;
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const first = document.getElementsByTagName('script')[0];
      first.parentNode.insertBefore(tag, first);
    }
  }

  _sendWatchPartyEvent(payload) {
    if (this.socket && this.socket.connected) {
      this.socket.emit('call:watchparty', { to: this.peer.id, payload });
    }
  }

  _onWatchParty({ from, payload }) {
    if (payload.action === 'start') {
      this._initWatchParty(payload.videoId, false);
    } else if (payload.action === 'play') {
      if (this.ytPlayer) this.ytPlayer.playVideo();
    } else if (payload.action === 'pause') {
      if (this.ytPlayer) {
        this.ytPlayer.pauseVideo();
        if (payload.time != null) this.ytPlayer.seekTo(payload.time, true);
      }
    } else if (payload.action === 'seek') {
      if (this.ytPlayer && payload.time != null) this.ytPlayer.seekTo(payload.time, true);
    } else if (payload.action === 'stop') {
      this._stopWatchParty(false);
    }
  }

  _stopWatchParty(notifyPeer = true) {
    const wrap = this.overlay.querySelector('.call-yt-wrapper');
    wrap.style.display = 'none';
    wrap.innerHTML = '<div id="yt-player-target"></div>';
    if (this.ytPlayer) {
      try { this.ytPlayer.destroy(); } catch {}
      this.ytPlayer = null;
    }
    this._stopAudioDucking();
    if (notifyPeer) {
      this._sendWatchPartyEvent({ action: 'stop' });
    }
  }

  _startAudioDucking() {
    this._stopAudioDucking();
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;

      if (this.remoteVideo.srcObject) {
        const source = audioCtx.createMediaStreamSource(this.remoteVideo.srcObject);
        source.connect(analyser);
      }

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      this.duckingAudioContext = audioCtx;

      this.duckingInterval = setInterval(() => {
        if (!this.ytPlayer || typeof this.ytPlayer.setVolume !== 'function') return;

        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;

        if (average > 12) {
          this.ytPlayer.setVolume(20);
        } else {
          this.ytPlayer.setVolume(85);
        }
      }, 300);
    } catch (err) {
      console.warn('Falha ao configurar ducking de áudio:', err);
    }
  }

  _stopAudioDucking() {
    if (this.duckingInterval) {
      clearInterval(this.duckingInterval);
      this.duckingInterval = null;
    }
    if (this.duckingAudioContext) {
      try { this.duckingAudioContext.close(); } catch {}
      this.duckingAudioContext = null;
    }
  }
}
