// Cryptographic primitives for VibeTube Mesh, on the Web Crypto API so the same
// code runs in Node 20+, modern browsers and the Android WebView.
//
// Per the spec (5.3):
//   Ed25519            — message signatures (authenticity / tamper-evidence)
//   X25519             — key agreement between two devices
//   HKDF-SHA256        — derive a symmetric key from the shared secret
//   AES-256-GCM        — authenticated encryption of private payloads
//   nonce (IV) unique per message
//
// Private keys are represented as JWK so an identity is a plain serializable
// object that a device can persist locally. They are NEVER meant to be shared:
// only the public bundle (raw public keys) leaves the device.

import { bytesToB64u, b64uToBytes, utf8ToBytes, bytesToUtf8, concatBytes } from './base64.js';

const subtle = globalThis.crypto.subtle;

const HKDF_INFO = utf8ToBytes('vibetube-mesh/v1');
const SALT_LEN = 16;
const IV_LEN = 12;

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export async function sha256(bytes) {
  const d = await subtle.digest('SHA-256', bytes);
  return new Uint8Array(d);
}

// ---------------------------------------------------------------- key material
export async function generateSigningKeyPair() {
  const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pubRaw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const privJwk = await subtle.exportKey('jwk', kp.privateKey);
  return { pub: bytesToB64u(pubRaw), priv: privJwk };
}

export async function generateKxKeyPair() {
  const kp = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const pubRaw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const privJwk = await subtle.exportKey('jwk', kp.privateKey);
  return { pub: bytesToB64u(pubRaw), priv: privJwk };
}

function importSignPublic(pubB64u) {
  return subtle.importKey('raw', b64uToBytes(pubB64u), { name: 'Ed25519' }, false, ['verify']);
}
function importSignPrivate(jwk) {
  return subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
}
function importKxPublic(pubB64u) {
  return subtle.importKey('raw', b64uToBytes(pubB64u), { name: 'X25519' }, false, []);
}
function importKxPrivate(jwk) {
  return subtle.importKey('jwk', jwk, { name: 'X25519' }, false, ['deriveBits']);
}

// ---------------------------------------------------------------- signatures
export async function signBytes(privJwk, bytes) {
  const key = await importSignPrivate(privJwk);
  const sig = await subtle.sign({ name: 'Ed25519' }, key, bytes);
  return bytesToB64u(new Uint8Array(sig));
}

export async function verifyBytes(pubB64u, sigB64u, bytes) {
  try {
    const key = await importSignPublic(pubB64u);
    return await subtle.verify({ name: 'Ed25519' }, key, b64uToBytes(sigB64u), bytes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- E2E encryption
// Derive the AES-GCM key shared by two devices: X25519(myPriv, theirPub) → HKDF.
async function deriveAesKey(myKxPrivJwk, theirKxPub, salt) {
  const priv = await importKxPrivate(myKxPrivJwk);
  const pub = await importKxPublic(theirKxPub);
  const sharedBits = await subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256);
  const hkdfKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Encrypt a string for a recipient. Returns base64url(salt | iv | ciphertext).
// `sender` is an identity (needs sender.kx.priv); `recipientKxPub` is the
// recipient's X25519 public key (base64url) from their public bundle.
export async function encryptMessage(plaintext, sender, recipientKxPub) {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveAesKey(sender.kx.priv, recipientKxPub, salt);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8ToBytes(plaintext));
  return bytesToB64u(concatBytes(salt, iv, new Uint8Array(ct)));
}

// Decrypt a payload produced by encryptMessage. `recipient` is an identity
// (needs recipient.kx.priv); `senderKxPub` is the sender's X25519 public key.
export async function decryptMessage(payloadB64u, recipient, senderKxPub) {
  const blob = b64uToBytes(payloadB64u);
  const salt = blob.slice(0, SALT_LEN);
  const iv = blob.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ct = blob.slice(SALT_LEN + IV_LEN);
  const key = await deriveAesKey(recipient.kx.priv, senderKxPub, salt);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return bytesToUtf8(new Uint8Array(pt));
}
