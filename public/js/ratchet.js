// SpeedVox Double Ratchet (Signal-style) for forward secrecy in direct chats.
//
// Each message uses a fresh message key derived from a ratcheting chain; chain
// keys and root keys advance and old keys are discarded, so compromising the
// current state does not reveal past messages (forward secrecy) and self-heals
// after compromise (post-compromise security) once a new DH ratchet step runs.
//
// Primitives (Web Crypto, also available in Node): ECDH P-256 (DH ratchet),
// HKDF-SHA256 (root KDF + message keys), HMAC-SHA256 (symmetric chain KDF),
// AES-GCM (message encryption with the header as associated data).
//
// Bootstrap: the initial root key is a shared secret both sides already share
// (HKDF of the static identity ECDH). The "responder" uses its identity key as
// the first DH ratchet key; after the first round both sides use ephemeral keys.

const subtle = crypto.subtle;
const MAX_SKIP = 256;

// ---- byte helpers ----
function b64(bytes) {
  let s = '';
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const x of a) s += String.fromCharCode(x);
  return btoa(s);
}
function ub64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const u8 = (a) => (a instanceof Uint8Array ? a : new Uint8Array(a));
const concat = (...arrs) => {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

// ---- crypto primitives ----
export async function genDH() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pubRaw = u8(await subtle.exportKey('raw', kp.publicKey));
  return { priv: kp.privateKey, pub: kp.publicKey, pubRaw: b64(pubRaw) };
}

async function importPub(pubRawB64) {
  return subtle.importKey('raw', ub64(pubRawB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

async function dh(privKey, pubRawB64) {
  const pub = await importPub(pubRawB64);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, privKey, 256);
  return u8(bits);
}

async function hkdf(saltBytes, ikmBytes, infoStr, len) {
  const key = await subtle.importKey('raw', ikmBytes, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: new TextEncoder().encode(infoStr) },
    key, len * 8
  );
  return u8(bits);
}

async function hmac(keyBytes, dataBytes) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return u8(await subtle.sign('HMAC', key, dataBytes));
}

// Root KDF: (RK', CK) = HKDF(salt=RK, ikm=DH output).
async function kdfRK(rk, dhOut) {
  const out = await hkdf(rk, dhOut, 'SpeedVox-Ratchet-RK', 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}
// Chain KDF: mk = HMAC(CK, 1); CK' = HMAC(CK, 2).
async function kdfCK(ck) {
  const mk = await hmac(ck, new Uint8Array([1]));
  const nck = await hmac(ck, new Uint8Array([2]));
  return [nck, mk];
}
// Message keys from a message key: AES key (32) + IV (12).
async function msgKeys(mk) {
  const out = await hkdf(new Uint8Array(32), mk, 'SpeedVox-Ratchet-Msg', 44);
  return { aesKey: out.slice(0, 32), iv: out.slice(32, 44) };
}

function headerAD(header) {
  return new TextEncoder().encode(`${header.dh}|${header.pn}|${header.n}`);
}

async function aesEncrypt(mk, plaintext, header) {
  const { aesKey, iv } = await msgKeys(mk);
  const key = await subtle.importKey('raw', aesKey, 'AES-GCM', false, ['encrypt']);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: headerAD(header) },
    key, new TextEncoder().encode(plaintext)
  );
  return b64(u8(ct));
}
async function aesDecrypt(mk, ctB64, header) {
  const { aesKey, iv } = await msgKeys(mk);
  const key = await subtle.importKey('raw', aesKey, 'AES-GCM', false, ['decrypt']);
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: headerAD(header) },
    key, ub64(ctB64)
  );
  return new TextDecoder().decode(pt);
}

// ---- ratchet state ----
// Roles: the party with the lexicographically greater identity public key is the
// initiator (Alice) and may send first; the other (Bob) bootstraps on first receipt.
export function pickRole(myIdPubB64, theirIdPubB64) {
  return myIdPubB64 > theirIdPubB64 ? 'alice' : 'bob';
}

export async function initAlice(skBytes, bobBootstrapPubB64) {
  const DHs = await genDH();
  const [RK, CKs] = await kdfRK(skBytes, await dh(DHs.priv, bobBootstrapPubB64));
  return { role: 'alice', DHs, DHr: bobBootstrapPubB64, RK, CKs, CKr: null, Ns: 0, Nr: 0, PN: 0, skipped: {} };
}

export async function initBob(skBytes, bobBootstrapKeyPair) {
  return { role: 'bob', DHs: bobBootstrapKeyPair, DHr: null, RK: skBytes, CKs: null, CKr: null, Ns: 0, Nr: 0, PN: 0, skipped: {} };
}

export function canSend(state) { return Boolean(state.CKs); }

export async function ratchetEncrypt(state, plaintext) {
  if (!state.CKs) throw new Error('ratchet: sem cadeia de envio ainda (aguarde a primeira mensagem do par)');
  const [nck, mk] = await kdfCK(state.CKs);
  state.CKs = nck;
  const header = { dh: state.DHs.pubRaw, pn: state.PN, n: state.Ns };
  state.Ns += 1;
  const ct = await aesEncrypt(mk, plaintext, header);
  return { header, ct };
}

async function skipMessageKeys(state, until) {
  if (state.Nr + MAX_SKIP < until) throw new Error('ratchet: muitas mensagens puladas');
  if (state.CKr) {
    while (state.Nr < until) {
      const [nck, mk] = await kdfCK(state.CKr);
      state.CKr = nck;
      state.skipped[`${state.DHr}:${state.Nr}`] = b64(mk);
      state.Nr += 1;
    }
  }
}

async function dhRatchet(state, header) {
  state.PN = state.Ns;
  state.Ns = 0;
  state.Nr = 0;
  state.DHr = header.dh;
  [state.RK, state.CKr] = await kdfRK(state.RK, await dh(state.DHs.priv, state.DHr));
  state.DHs = await genDH();
  [state.RK, state.CKs] = await kdfRK(state.RK, await dh(state.DHs.priv, state.DHr));
}

export async function ratchetDecrypt(state, header, ctB64) {
  const skipKey = `${header.dh}:${header.n}`;
  if (state.skipped[skipKey]) {
    const mk = ub64(state.skipped[skipKey]);
    delete state.skipped[skipKey];
    return aesDecrypt(mk, ctB64, header);
  }
  if (header.dh !== state.DHr) {
    await skipMessageKeys(state, header.pn);
    await dhRatchet(state, header);
  }
  await skipMessageKeys(state, header.n);
  const [nck, mk] = await kdfCK(state.CKr);
  state.CKr = nck;
  state.Nr += 1;
  return aesDecrypt(mk, ctB64, header);
}

// ---- (de)serialization for persistence ----
export async function serialize(state) {
  const out = {
    role: state.role,
    DHr: state.DHr,
    RK: b64(state.RK),
    CKs: state.CKs ? b64(state.CKs) : null,
    CKr: state.CKr ? b64(state.CKr) : null,
    Ns: state.Ns, Nr: state.Nr, PN: state.PN,
    skipped: state.skipped,
    DHs: {
      priv: await subtle.exportKey('jwk', state.DHs.priv),
      pub: await subtle.exportKey('jwk', state.DHs.pub),
      pubRaw: state.DHs.pubRaw,
    },
  };
  return JSON.stringify(out);
}

export async function deserialize(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  const priv = await subtle.importKey('jwk', o.DHs.priv, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = await subtle.importKey('jwk', o.DHs.pub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return {
    role: o.role,
    DHr: o.DHr,
    RK: ub64(o.RK),
    CKs: o.CKs ? ub64(o.CKs) : null,
    CKr: o.CKr ? ub64(o.CKr) : null,
    Ns: o.Ns, Nr: o.Nr, PN: o.PN,
    skipped: o.skipped || {},
    DHs: { priv, pub, pubRaw: o.DHs.pubRaw },
  };
}

export { b64, ub64 };
