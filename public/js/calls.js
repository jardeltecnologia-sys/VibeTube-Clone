// SpeedVox 1:1 voice & video calls over WebRTC.
// The Socket.IO server only relays signaling (SDP/ICE); audio and video flow
// directly peer-to-peer. The module owns its own full-screen call UI.

import { mediaConstraints, tuneAudioSdp, capVideoBitrate } from './webrtc-quality.js';

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export class CallManager {
  constructor({ socket, selfId, iceServers }) {
    this.socket = socket;
    this.selfId = selfId;
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
  }

  async _ensureMedia() {
    if (this.localStream) return this.localStream;
    this.localStream = await navigator.mediaDevices.getUserMedia(mediaConstraints(this.media));
    this.localVideo.srcObject = this.localStream;
    return this.localStream;
  }

  _createPeer() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('call:ice', { to: this.peer.id, callId: this.callId, candidate: e.candidate });
      }
    };
    pc.ontrack = (e) => {
      this.remoteVideo.srcObject = e.streams[0];
      this._setStatus(this.media === 'video' ? '' : 'Em chamada');
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) this.hangup(true);
      if (pc.connectionState === 'connected') this._startTimer();
    };
    return pc;
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
    this.socket.emit('call:invite', { to: peer.id, callId: this.callId, media });
  }

  async _onAccepted({ callId }) {
    if (callId !== this.callId || this.role !== 'caller') return;
    const pc = this._createPeer();
    const offer = await pc.createOffer();
    offer.sdp = tuneAudioSdp(offer.sdp);
    await pc.setLocalDescription(offer);
    if (this.media === 'video') capVideoBitrate(pc);
    this.socket.emit('call:sdp', { to: this.peer.id, callId: this.callId, sdp: pc.localDescription });
    this._setStatus('Conectando…');
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
      // Already busy — auto reject.
      this.socket.emit('call:reject', { to: from.id, callId });
      return;
    }
    this.peer = from;
    this.callId = callId;
    this.media = media;
    this.role = 'callee';
    this._showOverlay('incoming');
    this._setStatus(media === 'video' ? 'Chamada de vídeo recebida' : 'Chamada recebida');
  }

  async _accept() {
    try {
      await this._ensureMedia();
    } catch {
      this._toast('Não foi possível acessar microfone/câmera');
      this._reject();
      return;
    }
    this._createPeer();
    this.socket.emit('call:accept', { to: this.peer.id, callId: this.callId });
    this._showOverlay('active');
    this._setStatus('Conectando…');
  }

  _reject() {
    this.socket.emit('call:reject', { to: this.peer.id, callId: this.callId });
    this._reset();
  }

  // ---------------------------------------------------------------- sdp / ice
  async _onSdp({ callId, sdp }) {
    if (callId !== this.callId || !this.pc) return;
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    for (const c of this.pendingIce.splice(0)) {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    if (sdp.type === 'offer') {
      const answer = await this.pc.createAnswer();
      answer.sdp = tuneAudioSdp(answer.sdp);
      await this.pc.setLocalDescription(answer);
      if (this.media === 'video') capVideoBitrate(this.pc);
      this.socket.emit('call:sdp', { to: this.peer.id, callId: this.callId, sdp: this.pc.localDescription });
      this._showOverlay('active');
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
      this.socket.emit('call:end', { to: this.peer.id, callId: this.callId });
    }
    this._reset();
  }

  _reset() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.pc) { try { this.pc.close(); } catch {} this.pc = null; }
    if (this.localStream) { this.localStream.getTracks().forEach((t) => t.stop()); this.localStream = null; }
    this.pendingIce = [];
    this.callId = null;
    this.peer = null;
    this.role = null;
    this.startedAt = 0;
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
      <div class="call-info">
        <div class="call-avatar"></div>
        <div class="call-name"></div>
        <div class="call-status"></div>
      </div>
      <div class="call-controls">
        <button class="call-btn mute" title="Mudo">🎙️</button>
        <button class="call-btn cam" title="Câmera">🎥</button>
        <button class="call-btn accept" title="Atender">📞</button>
        <button class="call-btn hangup" title="Encerrar">📵</button>
      </div>`;
    document.body.append(o);
    this.overlay = o;
    this.remoteVideo = o.querySelector('.call-remote');
    this.localVideo = o.querySelector('.call-local');
    this.btnMute = o.querySelector('.mute');
    this.btnCam = o.querySelector('.cam');
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
    // Show the "accept" button only while a call is incoming and unanswered.
    this.btnAccept.style.display = phase === 'incoming' ? '' : 'none';
    this.btnCam.style.display = this.media === 'video' ? '' : 'none';
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
}
