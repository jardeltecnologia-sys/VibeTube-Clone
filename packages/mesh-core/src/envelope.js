// Message envelopes for VibeTube Mesh (spec 5.3).
//
// An envelope is the unit that travels the mesh. It carries routing metadata in
// the clear (so relays can forward without reading the message) and an opaque
// `payload` that, for private messages, is AES-GCM ciphertext.
//
// Signatures cover the IMMUTABLE fields only. The routing fields `ttl` and
// `hopCount` change at every hop, so they are deliberately excluded from the
// signature — otherwise forwarding would break authenticity.

import { signBytes, verifyBytes } from './crypto.js';
import { deviceIdMatches } from './identity.js';
import { utf8ToBytes } from './base64.js';

export const MESH_PROTOCOL_VERSION = 1;
export const DEFAULT_TTL = 5;                       // spec: initial hop limit = 5
export const DEFAULT_LIFETIME_MS = 60 * 60 * 1000;  // 1h, per the spec example
export const MESSAGE_TYPES = new Set(['chat', 'direct', 'presence', 'ack', 'sync', 'system']);

function uuid() {
  return globalThis.crypto.randomUUID();
}

// Deterministic byte encoding of the signed (immutable) part of an envelope.
function buildSigningBytes(env) {
  const canonical = {
    version: env.version,
    messageId: env.messageId,
    type: env.type,
    fromDeviceId: env.fromDeviceId,
    fromPublicKey: env.fromPublicKey,
    toDeviceId: env.toDeviceId ?? null,
    roomId: env.roomId ?? null,
    createdAt: env.createdAt,
    expiresAt: env.expiresAt ?? null,
    payload: env.payload ?? null,
  };
  return utf8ToBytes(JSON.stringify(canonical));
}

export function createEnvelope({
  type,
  toDeviceId = null,
  roomId = null,
  payload = null,
  ttl = DEFAULT_TTL,
  lifetimeMs = DEFAULT_LIFETIME_MS,
  createdAt = Date.now(),
}) {
  if (!MESSAGE_TYPES.has(type)) throw new Error(`invalid message type: ${type}`);
  return {
    version: MESH_PROTOCOL_VERSION,
    messageId: uuid(),
    type,
    fromDeviceId: null,
    fromPublicKey: null,
    toDeviceId,
    roomId,
    createdAt,
    expiresAt: createdAt + lifetimeMs,
    ttl,
    hopCount: 0,
    signature: null,
    payload,
  };
}

// Stamp the sender's identity and sign the immutable fields. Mutates and returns
// the envelope for convenience.
export async function signEnvelope(env, identity) {
  env.fromDeviceId = identity.deviceId;
  env.fromPublicKey = identity.sign.pub;
  env.signature = await signBytes(identity.sign.priv, buildSigningBytes(env));
  return env;
}

// Verify a received envelope: the deviceId must match its public key (anti-spoof)
// and the signature must be valid over the immutable fields.
export async function verifyEnvelope(env) {
  if (!env || !env.signature || !env.fromPublicKey || !env.fromDeviceId) return false;
  if (!(await deviceIdMatches(env.fromDeviceId, env.fromPublicKey))) return false;
  return verifyBytes(env.fromPublicKey, env.signature, buildSigningBytes(env));
}

export function isExpired(env, now = Date.now()) {
  return Boolean(env.expiresAt) && now > env.expiresAt;
}

// Returns a COPY with ttl decremented and hopCount incremented. The signature
// stays valid because it doesn't cover these fields.
export function decrementTTL(env) {
  return { ...env, ttl: env.ttl - 1, hopCount: env.hopCount + 1 };
}

export function serializeMessage(env) {
  return JSON.stringify(env);
}

export function deserializeMessage(str) {
  const env = typeof str === 'string' ? JSON.parse(str) : str;
  if (!env || env.version !== MESH_PROTOCOL_VERSION) throw new Error('unsupported envelope version');
  if (!env.messageId || !MESSAGE_TYPES.has(env.type)) throw new Error('malformed envelope');
  if (typeof env.ttl !== 'number' || typeof env.hopCount !== 'number') throw new Error('malformed routing fields');
  if (typeof env.createdAt !== 'number') throw new Error('malformed timestamp');
  return env;
}
