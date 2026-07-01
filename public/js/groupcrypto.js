// SpeedVox Sender Keys — E2EE de GRUPOS (estilo Signal).
//
// Cada remetente tem, por grupo, uma "sender key":
//   - uma CHAIN KEY simétrica (32B) que ratcheta a cada mensagem
//     (forward secrecy por remetente: mensagens anteriores não são reveladas se
//      a chave atual vazar);
//   - um par de chaves de ASSINATURA (ECDSA P-256). Só o remetente tem a privada,
//     então nenhum outro membro consegue se passar por ele (autenticidade).
//
// A chain key + a chave pública de assinatura são distribuídas a cada membro
// pelo canal E2EE PAR-A-PAR já existente (ver e2ee.js): o servidor nunca vê nada.
//
// Por mensagem:  messageKey = HMAC(chainKey, 0x01) -> AES-GCM
//                chainKey'  = HMAC(chainKey, 0x02)
//                assina (iteration || iv || ciphertext) com a chave privada.
//
// Primitivas: Web Crypto (também disponível no Node) — HMAC-SHA256, AES-GCM,
// ECDSA P-256 (SHA-256).

const subtle = crypto.subtle;
const MAX_SKIP = 512;

function b64(bytes) {
  let s = '';
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CH = 0x8000;
  for (let i = 0; i < a.length; i += CH) s += String.fromCharCode.apply(null, a.subarray(i, i + CH));
  return btoa(s);
}
function ub64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function u32(n) { return new Uint8Array(new Uint32Array([n >>> 0]).buffer); }

async function hmac(keyBytes, dataBytes) {
  const k = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, dataBytes));
}
const deriveMsgKey = (chainKey) => hmac(chainKey, new Uint8Array([1]));
const nextChain = (chainKey) => hmac(chainKey, new Uint8Array([2]));

// ---- Remetente ----------------------------------------------------------------
// Cria a sender key deste usuário para um grupo (chamar 1x por grupo; rotacionar
// quando alguém sai). Guarda a privada de assinatura só localmente.
export async function createSenderKey() {
  const chainKey = crypto.getRandomValues(new Uint8Array(32));
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    chainKey: b64(chainKey),
    iteration: 0,
    signPrivJwk: await subtle.exportKey('jwk', pair.privateKey),
    signPubJwk: await subtle.exportKey('jwk', pair.publicKey),
  };
}

// Mensagem de distribuição (o que cada membro precisa para decifrar deste
// remetente). Enviada a cada membro pelo canal par-a-par (nunca em claro).
export function distributionMessage(sender) {
  return { v: 1, ck: sender.chainKey, it: sender.iteration, spk: sender.signPubJwk };
}

// Cifra uma mensagem de grupo. Retorna o envelope + o NOVO estado do remetente
// (a chain key avançou). Persista o estado retornado.
export async function senderEncrypt(sender, plaintext) {
  const chainKey = ub64(sender.chainKey);
  const mk = await deriveMsgKey(chainKey);
  const aesKey = await subtle.importKey('raw', mk, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(plaintext)));
  const it = sender.iteration;
  const signPriv = await subtle.importKey('jwk', sender.signPrivJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signPriv, concat(u32(it), iv, ct)));
  const nextCk = await nextChain(chainKey);
  return {
    env: { v: 1, gk: 1, i: it, iv: b64(iv), ct: b64(ct), sig: b64(sig) },
    sender: { ...sender, chainKey: b64(nextCk), iteration: it + 1 },
  };
}

// ---- Destinatário -------------------------------------------------------------
export function receiverFromDistribution(dist) {
  return { chainKey: dist.ck, iteration: dist.it, signPubJwk: dist.spk, skipped: {} };
}

// Decifra um envelope de grupo. Verifica a assinatura (autenticidade) e ratcheta
// até o índice da mensagem, guardando chaves puladas (reordenação). Retorna o
// texto + o NOVO estado do destinatário (persistir).
export async function receiverDecrypt(recv, env) {
  const signPub = await subtle.importKey('jwk', recv.signPubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const iv = ub64(env.iv), ct = ub64(env.ct), sig = ub64(env.sig);
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, signPub, sig, concat(u32(env.i), iv, ct));
  if (!ok) throw new Error('assinatura de grupo inválida');

  let chainKey = ub64(recv.chainKey);
  let iteration = recv.iteration;
  const skipped = { ...(recv.skipped || {}) };

  let mk;
  if (env.i < iteration) {
    if (skipped[env.i]) { mk = ub64(skipped[env.i]); delete skipped[env.i]; }
    else throw new Error('chave já descartada (mensagem antiga)');
  } else {
    if (env.i - iteration > MAX_SKIP) throw new Error('muitas mensagens puladas');
    while (iteration < env.i) {
      skipped[iteration] = b64(await deriveMsgKey(chainKey));
      chainKey = await nextChain(chainKey);
      iteration++;
    }
    mk = await deriveMsgKey(chainKey);
    chainKey = await nextChain(chainKey);
    iteration++;
  }

  const aesKey = await subtle.importKey('raw', mk, { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
  return {
    plaintext: new TextDecoder().decode(pt),
    recv: { chainKey: b64(chainKey), iteration, signPubJwk: recv.signPubJwk, skipped },
  };
}
