// SpeedVox group voice/video calls (1:1 -> N:N) using a full WebRTC mesh:
// every participant holds a peer connection to every other participant. The
// server only relays signaling (join/leave + per-pair SDP/ICE). Owns its own
// grid UI. For large groups an SFU would scale better; full mesh is fine for
// small groups and keeps media end-to-end between peers.

import { mediaConstraints, tuneAudioSdp, capVideoBitrate } from './webrtc-quality.js';
import * as ringtone from './ringtone.js';

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export class GroupCallManager {
  constructor({ socket, selfId, iceServers, getUser }) {
    this.socket = socket;
    this.selfId = selfId;
    this.iceServers = iceServers && iceServers.length ? iceServers : DEFAULT_ICE;
    this.getUser = getUser; // (userId) => { displayName, avatarUrl }
    this.chatId = null;
    this.media = 'audio';
    this.localStream = null;
    this.peers = new Map(); // userId -> { pc, pendingIce: [], tile }
    this.active = false;
    this.incoming = null; // { chatId, from, media }
    this._bind();
    this._buildUI();
  }

  _bind() {
    const s = this.socket;
    s.on('gcall:incoming', (d) => this._onIncoming(d));
    s.on('gcall:peer-join', (d) => { /* they will offer to us; nothing to do */ });
    s.on('gcall:peer-leave', (d) => { if (d.chatId === this.chatId) this._dropPeer(d.userId); });
    s.on('gcall:signal', (d) => { if (d.chatId === this.chatId) this._onSignal(d.from, d.signal); });
    s.on('gcall:ended', (d) => { if (d.chatId === this.chatId) this.hangup(true); });
  }

  isActive(chatId) { return this.active && this.chatId === chatId; }

  async _ensureMedia() {
    if (this.localStream) return;
    this.localStream = await navigator.mediaDevices.getUserMedia(mediaConstraints(this.media));
  }

  // Start or join a group call for a chat.
  async start(chatId, media) {
    if (this.active) return;
    ringtone.stop();
    this.chatId = chatId;
    this.media = media === 'video' ? 'video' : 'audio';
    try { await this._ensureMedia(); }
    catch { this._toast('Não foi possível acessar microfone/câmera'); this._reset(); return; }
    this.active = true;
    this._showUI();
    this._addTile(this.selfId, this.localStream, true);
    this.socket.emit('gcall:join', { chatId, media: this.media }, (res) => {
      if (res && res.error) { this._toast('Não foi possível entrar na chamada'); this.hangup(); return; }
      for (const pid of (res && res.participants) || []) this._connectTo(pid, true);
    });
  }

  _connectTo(userId, initiator) {
    if (this.peers.has(userId)) return this.peers.get(userId);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 4 });
    const entry = { pc, pendingIce: [], tile: null, graceTimer: null };
    this.peers.set(userId, entry);
    for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket.emit('gcall:signal', { chatId: this.chatId, to: userId, signal: { ice: e.candidate } });
    };
    pc.ontrack = (e) => { entry.stream = e.streams[0]; this._addTile(userId, e.streams[0], false); };

    const onConnected = () => {
      if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
    };
    const onFailed = () => {
      // Only drop if still the active entry for this userId.
      if (this.peers.get(userId) === entry) this._dropPeer(userId);
    };
    const onDisconnected = () => {
      if (!entry.graceTimer) {
        entry.graceTimer = setTimeout(() => {
          entry.graceTimer = null;
          const connSt = pc.connectionState;
          const iceSt = pc.iceConnectionState;
          const ok = connSt === 'connected' || iceSt === 'connected' || iceSt === 'completed';
          if (!ok && this.peers.get(userId) === entry) this._dropPeer(userId);
        }, 20000);
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') onConnected();
      else if (st === 'failed' || st === 'closed') onFailed();
      else if (st === 'disconnected') onDisconnected();
    };
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') onConnected();
      else if (st === 'failed' || st === 'closed') onFailed();
      else if (st === 'disconnected') onDisconnected();
    };

    if (initiator) {
      pc.createOffer()
        .then((o) => { o.sdp = tuneAudioSdp(o.sdp); return pc.setLocalDescription(o); })
        .then(() => {
          if (this.media === 'video') capVideoBitrate(pc);
          this.socket.emit('gcall:signal', { chatId: this.chatId, to: userId, signal: { sdp: pc.localDescription } });
        })
        .catch(() => {});
    }
    return entry;
  }

  async _onSignal(from, signal) {
    if (!this.active) return;
    let entry = this.peers.get(from);
    if (!entry) entry = this._connectTo(from, false);
    const { pc } = entry;
    try {
      if (signal.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        for (const c of entry.pendingIce.splice(0)) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
        if (signal.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          answer.sdp = tuneAudioSdp(answer.sdp);
          await pc.setLocalDescription(answer);
          if (this.media === 'video') capVideoBitrate(pc);
          this.socket.emit('gcall:signal', { chatId: this.chatId, to: from, signal: { sdp: pc.localDescription } });
        }
      } else if (signal.ice) {
        if (pc.remoteDescription) { try { await pc.addIceCandidate(new RTCIceCandidate(signal.ice)); } catch {} }
        else entry.pendingIce.push(signal.ice);
      }
    } catch { /* ignore signaling errors */ }
  }

  _onIncoming(d) {
    if (this.active || (this.incoming && this.incoming.chatId === d.chatId)) return;
    this.incoming = d;
    this._showIncoming(d);
  }

  _dropPeer(userId) {
    const entry = this.peers.get(userId);
    if (!entry) return;
    if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
    this.peers.delete(userId); // Remove BEFORE close() to prevent re-entry via state events.
    const pc = entry.pc;
    entry.pc = null;
    try { pc.close(); } catch {}
    if (entry.tile) entry.tile.remove();
    this._reflow();
  }

  hangup(remote = false) {
    if (!remote && this.active) this.socket.emit('gcall:leave', { chatId: this.chatId });
    this._reset();
  }

  _reset() {
    ringtone.stop();
    for (const userId of [...this.peers.keys()]) this._dropPeer(userId);
    if (this.localStream) { this.localStream.getTracks().forEach((t) => t.stop()); this.localStream = null; }
    this.active = false;
    this.chatId = null;
    this.overlay.classList.add('hidden');
    this.grid.innerHTML = '';
  }

  // ---------------------------------------------------------------- UI
  _buildUI() {
    const o = document.createElement('div');
    o.className = 'gcall-overlay hidden';
    o.innerHTML = `
      <div class="gcall-grid"></div>
      <div class="gcall-controls">
        <button class="call-btn mute" title="Mudo">🎙️</button>
        <button class="call-btn cam" title="Câmera">🎥</button>
        <button class="call-btn hangup" title="Sair">📵</button>
      </div>`;
    document.body.append(o);
    this.overlay = o;
    this.grid = o.querySelector('.gcall-grid');
    o.querySelector('.hangup').onclick = () => this.hangup();
    o.querySelector('.mute').onclick = (e) => {
      const t = this.localStream && this.localStream.getAudioTracks()[0];
      if (t) { t.enabled = !t.enabled; e.currentTarget.classList.toggle('off', !t.enabled); }
    };
    o.querySelector('.cam').onclick = (e) => {
      const t = this.localStream && this.localStream.getVideoTracks()[0];
      if (t) { t.enabled = !t.enabled; e.currentTarget.classList.toggle('off', !t.enabled); }
    };
  }

  _showUI() {
    this.overlay.classList.remove('hidden');
    this.overlay.querySelector('.cam').style.display = this.media === 'video' ? '' : 'none';
  }

  _addTile(userId, stream, isLocal) {
    const existing = isLocal ? this.grid.querySelector('[data-self="1"]')
      : (this.peers.get(userId) && this.peers.get(userId).tile);
    const u = isLocal ? { displayName: 'Você' } : (this.getUser ? this.getUser(userId) : { displayName: '' });
    let tile = existing;
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'gcall-tile';
      if (isLocal) tile.dataset.self = '1';
      const video = document.createElement('video');
      video.autoplay = true; video.playsInline = true; if (isLocal) video.muted = true;
      const name = document.createElement('span');
      name.className = 'gcall-name';
      tile.append(video, name);
      this.grid.append(tile);
      if (!isLocal && this.peers.get(userId)) this.peers.get(userId).tile = tile;
    }
    tile.querySelector('video').srcObject = stream;
    tile.querySelector('.gcall-name').textContent = (u && u.displayName) || '';
    this._reflow();
  }

  _reflow() {
    const n = this.grid.children.length;
    const cols = n <= 1 ? 1 : (n <= 4 ? 2 : 3);
    this.grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  }

  _showIncoming(d) {
    const u = d.from || {};
    const banner = document.createElement('div');
    banner.className = 'gcall-incoming';
    banner.innerHTML = `<span>${(u.displayName || 'Alguém')} iniciou uma chamada em grupo (${d.media === 'video' ? 'vídeo' : 'voz'})</span>`;
    const join = document.createElement('button');
    join.className = 'btn-primary'; join.textContent = 'Entrar';
    const dismiss = document.createElement('button');
    dismiss.className = 'gcall-dismiss'; dismiss.textContent = 'Ignorar';
    join.onclick = () => { ringtone.stop(); banner.remove(); this.incoming = null; this.start(d.chatId, d.media); };
    dismiss.onclick = () => { ringtone.stop(); banner.remove(); this.incoming = null; };
    banner.append(join, dismiss);
    document.body.append(banner);
    ringtone.startIncoming();
    // Auto-dismiss if the call ends.
    const onEnded = (ev) => { if (ev.chatId === d.chatId) { ringtone.stop(); banner.remove(); this.socket.off('gcall:ended', onEnded); } };
    this.socket.on('gcall:ended', onEnded);
    setTimeout(() => { if (banner.isConnected) { ringtone.stop(); banner.remove(); this.incoming = null; } }, 30000);
  }

  _toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.append(t); setTimeout(() => t.remove(), 2600);
  }
}
