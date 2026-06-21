// SpeedVox end-to-end encryption (direct chats).
//
// Each user owns an ECDH P-256 identity key pair. The PRIVATE key never leaves
// the device (kept in localStorage); only the PUBLIC key is uploaded to the
// server. For a 1:1 chat both sides compute the SAME shared secret via
// ECDH(myPrivate, theirPublic) — that secret is turned into an AES-GCM key used
// to encrypt every message. The server only ever stores/relays ciphertext, so
// it cannot read messages.
//
// Limitation (documented): this uses a long-lived (static) ECDH secret per pair,
// so it is end-to-end encrypted but NOT forward-secret. The next step is a
// Double Ratchet (à la Signal) layered on top of these identity keys.

const KEYSTORE = 'speedvox_identity';

let identity = null; // { privateKey: CryptoKey, publicJwk: object }

export function isAvailable() {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function ub64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importPrivate(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
}
async function importPublic(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

// Load the identity from storage or create one. Returns the public JWK (string).
export async function initIdentity() {
  if (!isAvailable()) return null;
  const saved = localStorage.getItem(KEYSTORE);
  if (saved) {
    try {
      const { privateJwk, publicJwk } = JSON.parse(saved);
      identity = { privateKey: await importPrivate(privateJwk), publicJwk };
      return JSON.stringify(publicJwk);
    } catch { /* fall through and regenerate */ }
  }
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']
  );
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  localStorage.setItem(KEYSTORE, JSON.stringify({ privateJwk, publicJwk }));
  identity = { privateKey: pair.privateKey, publicJwk };
  return JSON.stringify(publicJwk);
}

export function myPublicKey() {
  return identity ? JSON.stringify(identity.publicJwk) : null;
}

// Derive an AES-GCM key from an explicit private key + peer public JWK.
// Exported separately so it can be unit-tested without touching storage.
export async function deriveSharedKey(privateKey, peerPublicJwk) {
  const jwk = typeof peerPublicJwk === 'string' ? JSON.parse(peerPublicJwk) : peerPublicJwk;
  const peerKey = await importPublic(jwk);
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Derive the shared key for a chat using my stored identity.
export async function deriveChatKey(peerPublicKeyString) {
  if (!identity || !peerPublicKeyString) return null;
  try {
    return await deriveSharedKey(identity.privateKey, peerPublicKeyString);
  } catch {
    return null;
  }
}

export async function encrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

export async function decrypt(key, envelope) {
  const env = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(env.iv) }, key, ub64(env.ct));
  return new TextDecoder().decode(pt);
}

// Bootstrap material for the Double Ratchet: the shared root secret (from the
// static identity ECDH), the role, the peer's identity public (raw), and our
// identity key re-imported for ECDH deriveBits (used as the responder's first
// ratchet key). Both peers compute the same secret and opposite roles.
export async function ratchetBootstrap(peerPublicKeyString) {
  if (!isAvailable() || !identity) return null;
  const saved = JSON.parse(localStorage.getItem(KEYSTORE) || 'null');
  if (!saved) return null;
  const C = { name: 'ECDH', namedCurve: 'P-256' };
  const myPriv = await crypto.subtle.importKey('jwk', saved.privateJwk, C, true, ['deriveBits']);
  const myPub = await crypto.subtle.importKey('jwk', saved.publicJwk, C, true, []);
  const myPubRaw = b64(new Uint8Array(await crypto.subtle.exportKey('raw', myPub)));

  const peerJwk = typeof peerPublicKeyString === 'string' ? JSON.parse(peerPublicKeyString) : peerPublicKeyString;
  const peerPub = await crypto.subtle.importKey('jwk', peerJwk, C, true, []);
  const peerPubRaw = b64(new Uint8Array(await crypto.subtle.exportKey('raw', peerPub)));

  const dhBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, myPriv, 256));
  const hk = await crypto.subtle.importKey('raw', dhBits, 'HKDF', false, ['deriveBits']);
  const sk = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('SpeedVox-Root') },
    hk, 256
  ));

  return {
    role: myPubRaw > peerPubRaw ? 'alice' : 'bob',
    sk,
    peerPubRaw,
    myDH: { priv: myPriv, pub: myPub, pubRaw: myPubRaw },
  };
}
