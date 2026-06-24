// SpeedVox mesh layer — delay-tolerant, multi-hop messaging for blackout/disaster.
//
// Goal: let people reach their family when there is NO internet at all. Once two
// devices are linked (over any transport), messages hop peer-to-peer across the
// mesh — A→B→C — so you can reach someone several "jumps" away even if you have
// no direct link to them. Messages for an unreachable person are held and
// forwarded when a path appears (store-and-forward / epidemic routing).
//
// The module is split in two concerns:
//   1. PROTOCOL (this file): envelopes, dedup, TTL flooding, store-and-forward,
//      addressing, ACKs, SOS. Transport-agnostic and fully unit-testable.
//   2. TRANSPORT (links): anything that can carry bytes to a directly-reachable
//      neighbour. Two implementations feed the same protocol:
//        - WebRTC DataChannels (server-signalled; used while online).
//        - Native "Nearby" (BLE / Wi-Fi Direct via a Capacitor plugin; used with
//          zero infrastructure). See mesh-nearby.js and NEARBY.md.
//
// A "link" is just { peerId, send(str) }. The protocol floods over every link it
// has, regardless of which transport opened it, so an online WebRTC peer and an
// offline Bluetooth peer relay for each other transparently.

import { splitMedia, MediaReassembler } from '/mesh-core/chunk.js';

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

// Protocol tunables.
const PROTO_VERSION = 1;
const DEFAULT_TTL = 8;          // max hops a message travels before being dropped
const SEEN_MAX = 5000;          // dedup cache size (ids)
const SEEN_TTL_MS = 60 * 60 * 1000;   // forget seen ids after 1h
const OUTBOX_MAX = 500;         // held messages waiting for a path
const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000; // hold undelivered for 24h

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class MeshManager extends EventTarget {
  constructor({ selfId, sendSignal, iceServers }) {
    super();
    this.selfId = selfId;
    this.sendSignal = sendSignal; // (toUserId, signalData) => void  (WebRTC signalling)
    this.iceServers = iceServers && iceServers.length ? iceServers : DEFAULT_ICE;

    // WebRTC peers: userId -> { pc, channel, ready }
    this.peers = new Map();
    // Unified link table the protocol floods over: peerId -> { send(str), kind }
    this.links = new Map();

    // Dedup cache: messageId -> timestamp seen.
    this.seen = new Map();
    // Store-and-forward: messageId -> { env, ts } held until a path appears.
    this.outbox = new Map();
    // Pending delivery confirmations we originated: messageId -> { resolve, timer }.
    this.pendingAcks = new Map();
    // Reassembles chunked media (voice notes, photos) arriving over the mesh.
    this.media = new MediaReassembler();

    this.enabled = false;
  }

  // ---------------------------------------------------------------- lifecycle
  setEnabled(on) {
    this.enabled = on;
    if (!on) this.teardown();
    this.dispatchEvent(new CustomEvent('status', { detail: this.status() }));
  }

  status() {
    let connected = 0;
    for (const l of this.links.values()) if (l) connected += 1;
    return { enabled: this.enabled, peers: connected, held: this.outbox.size };
  }

  // ---------------------------------------------------------------- links
  // Register a directly-reachable neighbour from ANY transport. `send` carries a
  // string frame to that neighbour. Called by the WebRTC layer and by native
  // transports (mesh-nearby.js).
  addLink(peerId, send, kind = 'webrtc') {
    if (!peerId || peerId === this.selfId) return;
    this.links.set(peerId, { send, kind });
    this.dispatchEvent(new CustomEvent('peer', { detail: { userId: peerId, ready: true, kind } }));
    this.dispatchEvent(new CustomEvent('status', { detail: this.status() }));
    // A path just appeared — try to push anything we were holding.
    this._flushOutbox();
  }

  removeLink(peerId) {
    if (this.links.delete(peerId)) {
      this.dispatchEvent(new CustomEvent('peer', { detail: { userId: peerId, ready: false } }));
      this.dispatchEvent(new CustomEvent('status', { detail: this.status() }));
    }
  }

  neighbors() {
    return [...this.links.keys()];
  }

  // ---------------------------------------------------------------- public send API
  // Send an application message toward a specific user across the mesh. Returns
  // the message id. If E2EE is in use, `data` should already be ciphertext — the
  // mesh never inspects it, so intermediate relays can't read it.
  sendMessage(toUserId, data, kind = 'msg') {
    const env = this._makeEnvelope({ to: toUserId, kind, data });
    this._originate(env);
    return env.id;
  }

  // Send a media item (voice note, photo, file) toward a user across the mesh.
  // The blob is split into chunks that each travel as a normal mesh message
  // (flooded, ACKed, store-and-forwarded) and are reassembled on the far side.
  // `meta` = { chatId, type, mime, name, b64 }. Returns the media id.
  sendMedia(toUserId, meta) {
    const mediaId = randomId();
    const chunks = splitMedia({ mediaId, type: meta.type, mime: meta.mime, name: meta.name, b64: meta.b64 });
    for (const c of chunks) this.sendMessage(toUserId, { ...c, chatId: meta.chatId || null }, 'media');
    return mediaId;
  }

  // Flood an emergency SOS to EVERYONE reachable (broadcast). `data` typically
  // carries { name, text, coords }. SOS is delivered locally on every node and
  // relayed onward so it reaches the whole connected component.
  sos(data) {
    const env = this._makeEnvelope({ to: '*', kind: 'sos', data, ttl: DEFAULT_TTL });
    this._originate(env);
    return env.id;
  }

  _makeEnvelope({ to, kind, data, ttl = DEFAULT_TTL }) {
    return { v: PROTO_VERSION, id: randomId(), origin: this.selfId, to, ttl, kind, ts: Date.now(), data };
  }

  // Route a freshly-created envelope. We mark it seen so our own re-floods don't
  // bounce back, then either deliver to a direct neighbour or flood; if there's
  // no path at all, hold it for later (store-and-forward).
  _originate(env) {
    this._markSeen(env.id);
    const reached = this._forward(env, null);
    if (!reached && env.to !== '*') this._hold(env);
  }

  // ---------------------------------------------------------------- receive
  // Feed a raw frame received from a direct neighbour into the protocol.
  receiveFrame(fromPeerId, raw) {
    if (!this.enabled) return;
    let env;
    try { env = JSON.parse(raw); } catch { return; }
    if (!env || env.v !== PROTO_VERSION || !env.id || this.seen.has(env.id)) return;
    this._markSeen(env.id);

    if (env.kind === 'ack') {
      if (env.to === this.selfId) this._resolveAck(env.data && env.data.ref);
      else this._forward(env, fromPeerId);
      return;
    }

    const forMe = env.to === this.selfId;
    const broadcast = env.to === '*';

    if (forMe || broadcast) {
      this._deliverLocal(env);
      // A unicast that reached its target gets an ACK sent back toward the origin.
      if (forMe && env.origin !== this.selfId) this._sendAck(env);
    }
    // Broadcasts keep flooding; unicasts not for us are relayed onward. If a
    // unicast can't be forwarded right now (no onward path), this relay holds it
    // and retries when a new link appears — epidemic store-and-forward.
    if (broadcast || !forMe) {
      const reached = this._forward(env, fromPeerId);
      if (!reached && !broadcast && env.to !== this.selfId) this._hold(env);
    }
  }

  _deliverLocal(env) {
    if (env.kind === 'sos') {
      this.dispatchEvent(new CustomEvent('sos', { detail: { from: env.origin, data: env.data, ts: env.ts } }));
    } else if (env.kind === 'media') {
      // One chunk of a media item. Reassemble (keyed by sender); emit only when
      // the whole thing has arrived.
      const done = this.media.add(env.data, env.origin);
      if (done) {
        this.dispatchEvent(new CustomEvent('media', {
          detail: { from: env.origin, chatId: env.data.chatId || null, ts: env.ts, ...done },
        }));
      }
    } else {
      this.dispatchEvent(new CustomEvent('message', { detail: { from: env.origin, data: env.data, ts: env.ts } }));
    }
  }

  // ---------------------------------------------------------------- forwarding
  // Forward an envelope across the mesh, excluding the neighbour it came from.
  // Returns true if it was handed to at least one link (i.e. a path existed).
  _forward(env, exceptPeerId) {
    if (env.ttl <= 0) return false;
    const hop = { ...env, ttl: env.ttl - 1 };
    if (hop.ttl <= 0 && env.to !== '*') {
      // Out of hops for a unicast: still try a direct neighbour if it's the target.
      const direct = this.links.get(env.to);
      if (direct) { this._safeSend(direct, hop); return true; }
      return false;
    }
    const raw = JSON.stringify(hop);

    // Unicast with the target as a direct neighbour: send straight to it.
    if (env.to !== '*') {
      const direct = this.links.get(env.to);
      if (direct) { this._safeSendRaw(direct, raw); /* keep flooding too for redundancy */ }
    }

    let delivered = 0;
    for (const [peerId, link] of this.links) {
      if (peerId === exceptPeerId) continue;
      if (this._safeSendRaw(link, raw)) delivered += 1;
    }
    return delivered > 0;
  }

  _safeSend(link, env) { return this._safeSendRaw(link, JSON.stringify(env)); }
  _safeSendRaw(link, raw) {
    try { link.send(raw); return true; } catch { return false; }
  }

  // ---------------------------------------------------------------- ACKs
  _sendAck(env) {
    const ack = this._makeEnvelope({ to: env.origin, kind: 'ack', data: { ref: env.id }, ttl: DEFAULT_TTL });
    this._markSeen(ack.id);
    this._forward(ack, null);
  }

  // Resolve a pending delivery promise when our message's ACK comes back.
  _resolveAck(refId) {
    if (!refId) return;
    const p = this.pendingAcks.get(refId);
    if (p) { clearTimeout(p.timer); p.resolve(true); this.pendingAcks.delete(refId); }
    // Once acknowledged, we no longer need to hold it.
    this.outbox.delete(refId);
    this.dispatchEvent(new CustomEvent('delivered', { detail: { id: refId } }));
  }

  // ---------------------------------------------------------------- store-and-forward
  _hold(env) {
    if (this.outbox.size >= OUTBOX_MAX) {
      // Drop the oldest held message to bound memory.
      const oldest = this.outbox.keys().next().value;
      if (oldest) this.outbox.delete(oldest);
    }
    this.outbox.set(env.id, { env, ts: Date.now() });
    this.dispatchEvent(new CustomEvent('status', { detail: this.status() }));
  }

  // Try to push everything we're holding (called when a new link appears).
  _flushOutbox() {
    const now = Date.now();
    for (const [id, item] of [...this.outbox]) {
      if (now - item.ts > OUTBOX_TTL_MS) { this.outbox.delete(id); continue; }
      const reached = this._forward(item.env, null);
      if (reached) this.outbox.delete(id);
    }
    this.dispatchEvent(new CustomEvent('status', { detail: this.status() }));
  }

  // ---------------------------------------------------------------- dedup cache
  _markSeen(id) {
    this.seen.set(id, Date.now());
    if (this.seen.size > SEEN_MAX) {
      const cutoff = Date.now() - SEEN_TTL_MS;
      for (const [k, t] of this.seen) {
        if (t < cutoff) this.seen.delete(k);
        if (this.seen.size <= SEEN_MAX) break;
      }
      // Still too big? drop oldest insertions.
      while (this.seen.size > SEEN_MAX) {
        const oldest = this.seen.keys().next().value;
        this.seen.delete(oldest);
      }
    }
  }

  // ================================================================ WebRTC transport
  // The original transport: server-relayed signalling opens DataChannels which
  // then become protocol links. Survives a later server outage (the channel
  // stays up), which is exactly the "server falls, mesh keeps going" case.

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
        // Register as a protocol link so flooding can use it.
        this.addLink(userId, (raw) => channel.send(raw), 'webrtc');
      };
      channel.onclose = () => this._dropPeer(userId);
      channel.onmessage = (ev) => this.receiveFrame(userId, ev.data);
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

  // Handle an incoming WebRTC signal relayed from another peer.
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

  _dropPeer(userId) {
    const entry = this.peers.get(userId);
    if (entry) {
      try { entry.pc.close(); } catch {}
      this.peers.delete(userId);
    }
    this.removeLink(userId);
  }

  teardown() {
    for (const userId of [...this.peers.keys()]) this._dropPeer(userId);
    // Native links (if any) are torn down by their own transport on disable.
    this.links.clear();
  }
}
