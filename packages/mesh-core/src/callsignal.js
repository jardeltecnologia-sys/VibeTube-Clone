// Call signaling over the mesh — Stage 3 foundation ("ligação em apagão").
//
// 1:1 calls use WebRTC; the media flows peer-to-peer, but the SDP/ICE handshake
// normally rides the Socket.IO server. In a blackout there is no server, so this
// module defines a tiny, server-free signal format that can travel over the mesh
// (flooded + store-and-forward like any mesh message) and the mapping back to the
// CallManager handlers — mirroring the shapes the server would have produced.
//
// Pure logic (no DOM, no WebRTC, no transport) so it is unit-testable in Node and
// reusable in the browser (served at /mesh-core/callsignal.js). The browser glue
// (CallManager.onMeshSignal / _send) just calls these functions.

'use strict';

// Mesh message kind used to carry call signals.
export const CALL_SIGNAL_KIND = 'csig';

// Build the outgoing mesh signal object for a call action.
//   t: 'invite' | 'accept' | 'reject' | 'sdp' | 'ice' | 'end'
export function buildCallSignal(t, { callId, media, sdp, candidate, from } = {}) {
  const sig = { t, callId };
  if (t === 'invite') {
    sig.media = media === 'video' ? 'video' : 'audio';
    if (from) sig.from = from; // caller's public profile so the callee can show it
  } else if (t === 'sdp') {
    sig.sdp = sdp;
  } else if (t === 'ice') {
    sig.candidate = candidate;
  }
  return sig;
}

// Map an incoming mesh call signal to { handler, payload } describing which
// CallManager method to invoke and with what argument (matching the Socket.IO
// event payloads). `fromUserId` is the mesh origin, used as a fallback identity.
// Returns null for malformed/unknown signals.
export function routeCallSignal(signal, fromUserId) {
  if (!signal || typeof signal.t !== 'string' || !signal.callId) return null;
  const callId = signal.callId;
  switch (signal.t) {
    case 'invite':
      return {
        handler: '_onIncoming',
        payload: {
          from: signal.from || { id: fromUserId, displayName: '' },
          callId,
          media: signal.media === 'video' ? 'video' : 'audio',
        },
      };
    case 'accept':
      return { handler: '_onAccepted', payload: { callId } };
    case 'reject':
      return { handler: '_onRejected', payload: { callId } };
    case 'sdp':
      if (!signal.sdp) return null;
      return { handler: '_onSdp', payload: { callId, sdp: signal.sdp } };
    case 'ice':
      if (!signal.candidate) return null;
      return { handler: '_onIce', payload: { callId, candidate: signal.candidate } };
    case 'end':
      return { handler: '_onEnded', payload: { callId } };
    default:
      return null;
  }
}
