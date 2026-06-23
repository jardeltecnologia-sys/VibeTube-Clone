// Local device identity for VibeTube Mesh (spec 5.2).
//
// Each install owns one identity: a signing keypair (Ed25519) and a key-exchange
// keypair (X25519). The deviceId is derived from the signing public key, so it
// is stable, self-certifying, and depends on NO sensitive data (no IMEI, phone
// number, etc.). Private keys never leave the device — only publicIdentity() is
// meant to be shared / registered with the backend.

import { generateSigningKeyPair, generateKxKeyPair, sha256 } from './crypto.js';
import { b64uToBytes, bytesToB64u } from './base64.js';

const IDENTITY_VERSION = 1;

// deviceId = first 16 bytes of SHA-256(signing public key), base64url. Short,
// collision-resistant in practice, and verifiable against the public key.
async function deriveDeviceId(signPubB64u) {
  const hash = await sha256(b64uToBytes(signPubB64u));
  return bytesToB64u(hash.slice(0, 16));
}

export async function generateDeviceIdentity({ displayName = '', avatar = null } = {}) {
  const sign = await generateSigningKeyPair();
  const kx = await generateKxKeyPair();
  const deviceId = await deriveDeviceId(sign.pub);
  const now = Date.now();
  return {
    version: IDENTITY_VERSION,
    deviceId,
    displayName,
    avatar,
    sign,          // { pub: b64u, priv: JWK }  — signing (Ed25519)
    kx,            // { pub: b64u, priv: JWK }  — key agreement (X25519)
    createdAt: now,
    lastKeyRotationAt: now,
  };
}

// The shareable public half of an identity. This is what register-device sends
// and what peers store to verify signatures and encrypt to this device.
export function publicIdentity(identity) {
  return {
    deviceId: identity.deviceId,
    displayName: identity.displayName || '',
    avatar: identity.avatar || null,
    signPub: identity.sign.pub,
    kxPub: identity.kx.pub,
  };
}

// Rotate the device's keys, keeping the same logical device record. Note the
// deviceId changes because it is bound to the signing key — callers that need a
// constant id across rotations should track their own stable handle.
export async function rotateIdentityKeys(identity) {
  const next = await generateDeviceIdentity({
    displayName: identity.displayName,
    avatar: identity.avatar,
  });
  next.createdAt = identity.createdAt;
  return next;
}

// Validate that a deviceId really matches a signing public key (anti-spoof).
export async function deviceIdMatches(deviceId, signPubB64u) {
  try {
    return deviceId === (await deriveDeviceId(signPubB64u));
  } catch {
    return false;
  }
}

export function serializeIdentity(identity) {
  return JSON.stringify(identity);
}

export function deserializeIdentity(str) {
  const obj = typeof str === 'string' ? JSON.parse(str) : str;
  if (!obj || obj.version !== IDENTITY_VERSION || !obj.sign || !obj.kx) {
    throw new Error('invalid identity');
  }
  return obj;
}
