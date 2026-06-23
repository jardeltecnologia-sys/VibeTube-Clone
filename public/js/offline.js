// SpeedVox Offline Mode — bridges the platform-independent mesh-core (Phase 2)
// into the running app: a persistent local cryptographic identity, a crypto
// self-test (so a device can prove its WebView supports the required curves),
// and helpers to talk to the Phase 1 backend (/api/mesh/*).
//
// This file is pure logic (no DOM). The UI lives in app.js, which already has
// the el()/modalShell()/toast() helpers. mesh-core is served at /mesh-core/.

import * as mc from '/mesh-core/index.js';

const IDENTITY_KEY = 'speedvox_mesh_identity';
const TOKEN_KEY = 'speedvox_token';

let identity = null;

// Generate the device's offline identity once and persist it locally. The
// private keys never leave the device (localStorage on this device only).
export async function ensureIdentity(displayName = '') {
  if (identity) return identity;
  const saved = localStorage.getItem(IDENTITY_KEY);
  if (saved) {
    try { identity = mc.deserializeIdentity(saved); return identity; } catch { /* regenerate */ }
  }
  identity = await mc.generateDeviceIdentity({ displayName });
  localStorage.setItem(IDENTITY_KEY, mc.serializeIdentity(identity));
  return identity;
}

export function getIdentity() { return identity; }

export function publicIdentity() {
  return identity ? mc.publicIdentity(identity) : null;
}

export async function resetIdentity(displayName = '') {
  localStorage.removeItem(IDENTITY_KEY);
  identity = null;
  return ensureIdentity(displayName);
}

// Exercise the whole crypto path on THIS device. Returns a structured result so
// the diagnostics screen can show exactly which step fails on a given phone.
export async function cryptoSelfTest() {
  const steps = [];
  try {
    const a = await mc.generateDeviceIdentity({ displayName: 'A' });
    const b = await mc.generateDeviceIdentity({ displayName: 'B' });
    steps.push({ name: 'Gerar identidades (Ed25519 + X25519)', ok: Boolean(a.deviceId && b.deviceId) });

    const payload = await mc.encryptMessage('teste-secreto', a, mc.publicIdentity(b).kxPub);
    const env = mc.createEnvelope({ type: 'direct', toDeviceId: b.deviceId, payload });
    await mc.signEnvelope(env, a);
    steps.push({ name: 'Assinar envelope (Ed25519)', ok: Boolean(env.signature) });

    steps.push({ name: 'Verificar assinatura', ok: await mc.verifyEnvelope(env) });

    const tampered = { ...env, payload: (env.payload || '') + 'x' };
    steps.push({ name: 'Detectar adulteração', ok: !(await mc.verifyEnvelope(tampered)) });

    const decrypted = await mc.decryptMessage(env.payload, b, mc.publicIdentity(a).kxPub);
    steps.push({ name: 'Cifrar + decifrar (X25519 + AES-256-GCM)', ok: decrypted === 'teste-secreto' });

    return { ok: steps.every((s) => s.ok), steps };
  } catch (e) {
    return { ok: false, steps, error: (e && e.message) || String(e) };
  }
}

// Register (or refresh) this device's PUBLIC identity with the backend. Links to
// the logged-in account if a token is present. Best-effort; needs internet.
export async function registerDevice() {
  const pid = publicIdentity();
  if (!pid) return { ok: false, error: 'sem identidade' };
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch('/api/mesh/register-device', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deviceId: pid.deviceId,
      publicKey: { signPub: pid.signPub, kxPub: pid.kxPub },
      displayName: pid.displayName,
    }),
  });
  return res.json();
}

// Fetch the backend's mesh status + config (Phase 1 endpoints).
export async function meshBackendInfo() {
  const [s, c] = await Promise.allSettled([
    fetch('/api/mesh/status').then((r) => r.json()),
    fetch('/api/mesh/config').then((r) => r.json()),
  ]);
  return {
    status: s.status === 'fulfilled' ? s.value : null,
    config: c.status === 'fulfilled' ? c.value : null,
  };
}

// Is a native zero-infrastructure transport (BLE / Wi-Fi Direct) present?
export function nativeAvailable(meshNearby) {
  return Boolean(meshNearby && meshNearby.available);
}
