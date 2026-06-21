// SpeedVox mesh layer.
//
// Goal: keep conversations flowing even when the central server is unreachable
// (a blackout, a congested cell tower, a local-only Wi-Fi). The mesh establishes
// direct WebRTC DataChannels between peers. When the server IS reachable it is
// used only for signaling (exchanging SDP/ICE). The architecture is designed so
// that signaling can later be swapped for a serverless transport (BLE / Wi-Fi
// Direct / LAN mDNS via a native shell) to achieve a true offline mesh.
//
// This module is intentionally transport-agnostic: give it a `signal(to, data)`
// sender and feed it incoming signals, and it manages the peer connections.

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export class MeshManager extends EventTarget {
  constructor({ selfId, sendSignal, iceServers }) {
    super();
    this.selfId = selfId;
    this.sendSignal = sendSignal; // (toUserId, signalData) => void
    this.iceServers = iceServers && iceServers.length ? iceServers : DEFAULT_ICE;
    this.peers = new Map(); // userId -> { pc, channel, ready }
    this.enabled = false;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.teardown();
    this.dispatchEvent(new CustomEvent('status', { detail: this.status() }));
  }

  status() {
    let connected = 0;
    for (const p of this.peers.values()) if (p.ready) connected += 1;
    return { enabled: this.enabled, peers: connected };
  }

  _createPeer(userId, initiator) {
    if (this.peers.has(userId)) return this.peers.get(userId);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const entry = { pc, channel: null, ready: false };
    this.peers.set(userId, entry);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal(userId, { candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this._dropPeer(userId);
      }
    };

    const bind = (channel) => {
      entry.channel = channel;
      channel.onopen = () => {
        entry.ready = true;
        this.dispatchEvent(new CustomEvent('peer', { detail: { userId, ready: true } }));
        this.dispatchEvent(new CustomEvent('status', { detail: this.status() }));
      };
      channel.onclose = () => this._dropPeer(userId);
      channel.onmessage = (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        this.dispatchEvent(new CustomEvent('message', { detail: { from: userId, data } }));
      };
    };

    if (initiator) {
      bind(pc.createDataChannel('speedvox'));
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => this.sendSignal(userId, { sdp: pc.localDescription }))
        .catch(() => {});
    } else {
      pc.ondatachannel = (e) => bind(e.channel);
    }
    return entry;
  }

  // Begin (or refresh) a connection to a peer. Lower id initiates to avoid glare.
  connect(userId) {
    if (!this.enabled || userId === this.selfId) return;
    const initiator = this.selfId < userId;
    this._createPeer(userId, initiator);
  }

  // Handle an incoming signal relayed from another peer.
  async onSignal(from, signal) {
    if (!this.enabled) return;
    let entry = this.peers.get(from);
    if (!entry) entry = this._createPeer(from, false);
    const { pc } = entry;
    try {
      if (signal.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.sendSignal(from, { sdp: pc.localDescription });
        }
      } else if (signal.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (err) {
      console.warn('mesh signal error', err);
    }
  }

  // Send a payload directly to a peer over the data channel. Returns true if delivered.
  sendTo(userId, data) {
    const entry = this.peers.get(userId);
    if (entry && entry.ready) {
      entry.channel.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  // Broadcast to every connected peer (flooding — the basis of mesh relay).
  broadcast(data) {
    let count = 0;
    for (const [userId, entry] of this.peers) {
      if (entry.ready) { entry.channel.send(JSON.stringify(data)); count += 1; }
    }
    return count;
  }

  _dropPeer(userId) {
    const entry = this.peers.get(userId);
    if (!entry) return;
    try { entry.pc.close(); } catch {}
    this.peers.delete(userId);
    this.dispatchEvent(new CustomEvent('peer', { detail: { userId, ready: false } }));
    this.dispatchEvent(new CustomEvent('status', { detail: this.status() }));
  }

  teardown() {
    for (const userId of [...this.peers.keys()]) this._dropPeer(userId);
  }
}
