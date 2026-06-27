// Bloqueio do app (SpeedVox) — privacidade no aparelho.
//
// Guarda um PIN como hash (SHA-256 + sal) no próprio aparelho; o PIN em si
// nunca é salvo. Opcionalmente desbloqueia com a DIGITAL/biometria via WebAuthn
// (autenticador da plataforma). Tudo local — não depende do servidor.

const KEY = 'speedvox_applock';
const LOCK_AFTER_MS = 30 * 1000; // re-bloqueia se ficar 30s em segundo plano
const textEncoder = new TextEncoder();

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } }
function store(v) { localStorage.setItem(KEY, JSON.stringify(v)); }
function wipe() { localStorage.removeItem(KEY); }

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function randHex(n) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return toHex(a);
}
async function hashPin(pin, salt) {
  const buf = await crypto.subtle.digest('SHA-256', textEncoder.encode(`${salt}:${pin}`));
  return toHex(buf);
}

export function isEnabled() { return !!load(); }
export function biometricEnabled() { const c = load(); return !!(c && c.biometric); }

export async function enable(pin, { biometric = false } = {}) {
  const salt = randHex(16);
  const hash = await hashPin(pin, salt);
  const cur = load() || {};
  store({ salt, hash, biometric, credId: biometric ? cur.credId : undefined, at: Date.now(), panicSalt: cur.panicSalt, panicHash: cur.panicHash });
}
export async function enablePanic(pin) {
  const salt = randHex(16);
  const hash = await hashPin(pin, salt);
  const cur = load() || {};
  cur.panicSalt = salt;
  cur.panicHash = hash;
  store(cur);
}
export function disable() { wipe(); }
export async function verifyPin(pin) {
  const c = load(); if (!c) return 'real';
  const isReal = (await hashPin(pin, c.salt)) === c.hash;
  if (isReal) return 'real';
  if (c.panicHash && (await hashPin(pin, c.panicSalt)) === c.panicHash) {
    return 'panic';
  }
  return false;
}

// ---- Biometria (WebAuthn / digital do aparelho) ----
export async function biometricAvailable() {
  try {
    return !!(window.PublicKeyCredential
      && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch { return false; }
}

// Registra uma credencial de plataforma (pede a digital uma vez). Devolve o id.
export async function biometricRegister() {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'SpeedVox', id: location.hostname },
      user: { id: userId, name: 'speedvox', displayName: 'SpeedVox' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60000,
      attestation: 'none',
    },
  });
  const credId = toHex(new Uint8Array(cred.rawId));
  const c = load() || {};
  c.biometric = true; c.credId = credId;
  store(c);
  return credId;
}

// Pede a digital pra desbloquear. Resolve true se passou, lança se falhou.
async function biometricVerify() {
  const c = load();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  await navigator.credentials.get({
    publicKey: {
      challenge,
      timeout: 60000,
      userVerification: 'required',
      rpId: location.hostname,
      allowCredentials: c && c.credId ? [{ type: 'public-key', id: fromHex(c.credId) }] : [],
    },
  });
  return true;
}

// ---- Tela de bloqueio ----
function buildOverlay(onUnlock) {
  const ov = document.createElement('div');
  ov.className = 'applock-overlay';
  ov.innerHTML = `
    <div class="applock-card">
      <img src="/icons/icon.svg" class="applock-logo" alt="SpeedVox">
      <div class="applock-title">SpeedVox bloqueado</div>
      <div class="applock-sub">Digite seu PIN para continuar</div>
      <input class="applock-pin" type="password" inputmode="numeric" autocomplete="off"
             maxlength="12" placeholder="• • • •" />
      <div class="applock-error"></div>
      <button class="applock-unlock">Desbloquear</button>
      <button class="applock-bio hidden">🔑 Usar digital</button>
    </div>`;
  const input = ov.querySelector('.applock-pin');
  const err = ov.querySelector('.applock-error');
  const unlockBtn = ov.querySelector('.applock-unlock');
  const bioBtn = ov.querySelector('.applock-bio');

  function done() { ov.remove(); armAutoLock(); onUnlock(); }

  async function tryPin() {
    const res = await verifyPin(input.value);
    if (res === 'real') {
      done();
    } else if (res === 'panic') {
      localStorage.setItem('speedvox_panic_active', '1');
      localStorage.removeItem('speedvox_identity');
      localStorage.removeItem('speedvox_me');
      localStorage.removeItem('speedvox_chats');
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('speedvox_ratchet_')) {
          localStorage.removeItem(k);
          i--;
        }
      }
      done();
      location.reload();
    } else {
      err.textContent = 'PIN incorreto'; input.value = ''; input.focus();
    }
  }
  unlockBtn.addEventListener('click', tryPin);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryPin(); });

  if (biometricEnabled()) {
    bioBtn.classList.remove('hidden');
    const runBio = async () => {
      err.textContent = '';
      try { await biometricVerify(); done(); }
      catch { err.textContent = 'Não reconhecido. Use o PIN ou tente de novo.'; }
    };
    bioBtn.addEventListener('click', runBio);
    // Tenta a digital automaticamente ao abrir.
    setTimeout(runBio, 250);
  } else {
    setTimeout(() => input.focus(), 100);
  }
  return ov;
}

// Mostra a tela de bloqueio se estiver ativado. Resolve quando desbloquear.
export function guard() {
  return new Promise((resolve) => {
    if (!isEnabled()) { armAutoLock(); return resolve(); }
    document.body.appendChild(buildOverlay(resolve));
  });
}

// Re-bloqueia ao voltar do segundo plano depois de um tempo.
let autoLockArmed = false;
let hiddenAt = 0;
function armAutoLock() {
  if (autoLockArmed) return;
  autoLockArmed = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (!isEnabled()) return;
    if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) {
      if (!document.querySelector('.applock-overlay')) {
        document.body.appendChild(buildOverlay(() => {}));
      }
    }
  });
}
