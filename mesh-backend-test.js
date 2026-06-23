// Phase 1 backend tests: mesh endpoints + acceptance criteria
//   - SpeedVox stays healthy (/api/health, /api/ice still work)
//   - mesh endpoints respond (status, config, register-device, sync)
//   - basic validation, dedup, batch/size limits
//   - no secrets exposed
// Assumes the server is running on BASE (default 3001).
// Run:  node mesh-backend-test.js

const BASE = process.env.BASE || 'http://localhost:3001';

async function api(path, method = 'GET', body, token) {
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => null);
  return { status: r.status, body: d };
}

function envelope(over = {}) {
  return {
    version: 1,
    messageId: over.messageId || `m-${Math.random().toString(36).slice(2)}`,
    type: 'chat',
    fromDeviceId: 'dev-aaa',
    fromPublicKey: 'pk-aaa',
    toDeviceId: null,
    roomId: 'sala-1',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600000,
    ttl: 5,
    hopCount: 0,
    signature: 'sig-xxx',
    payload: 'ola',
    ...over,
  };
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };

  // --- regression: existing endpoints still work ---
  const health = await api('/api/health');
  ok(health.status === 200 && health.body && health.body.ok, '/api/health continua saudável');
  const ice = await api('/api/ice');
  ok(ice.status === 200 && Array.isArray(ice.body.iceServers), '/api/ice continua entregando ICE servers');

  // --- status + config ---
  const status = await api('/api/mesh/status');
  ok(status.status === 200 && status.body.enabled === true, '/api/mesh/status responde enabled');
  ok(typeof status.body.serverTime === 'number', '/api/mesh/status traz serverTime');

  const cfg = await api('/api/mesh/config');
  ok(cfg.status === 200 && cfg.body.maxTTL === 5 && cfg.body.maxBatchSize === 100, '/api/mesh/config traz limites');
  ok(JSON.stringify(cfg.body).toLowerCase().indexOf('secret') === -1
    && JSON.stringify(cfg.body).indexOf('jwt') === -1, '/api/mesh/config não expõe segredos');

  // --- register-device (anonymous) ---
  const reg = await api('/api/mesh/register-device', 'POST', {
    deviceId: 'dev-aaa',
    publicKey: { signPub: 'sp', kxPub: 'kp' },
    displayName: 'Aparelho A',
  });
  ok(reg.status === 200 && reg.body.ok && reg.body.linkedUser === null, 'register-device aceita identidade anônima');
  const regBad = await api('/api/mesh/register-device', 'POST', { publicKey: {} });
  ok(regBad.status === 400, 'register-device rejeita sem deviceId');

  // --- sync: accept, dedup, validation, limits ---
  const id1 = 'msg-unico-1';
  const sync1 = await api('/api/mesh/sync', 'POST', { deviceId: 'dev-aaa', messages: [envelope({ messageId: id1 })] });
  ok(sync1.status === 200 && sync1.body.accepted.includes(id1), 'sync aceita mensagem válida nova');

  const sync2 = await api('/api/mesh/sync', 'POST', { deviceId: 'dev-aaa', messages: [envelope({ messageId: id1 })] });
  ok(sync2.body.duplicates.includes(id1) && sync2.body.accepted.length === 0, 'sync deduplica por messageId');

  const badType = await api('/api/mesh/sync', 'POST', { messages: [envelope({ messageId: 'm-x', type: 'malware' })] });
  ok(badType.body.rejected.length === 1 && badType.body.rejected[0].reason === 'bad-type', 'sync rejeita tipo inválido');

  const unsigned = await api('/api/mesh/sync', 'POST', { messages: [envelope({ messageId: 'm-y', signature: null })] });
  ok(unsigned.body.rejected[0] && unsigned.body.rejected[0].reason === 'unsigned', 'sync rejeita envelope sem assinatura');

  const bigTtl = await api('/api/mesh/sync', 'POST', { messages: [envelope({ messageId: 'm-z', ttl: 99 })] });
  ok(bigTtl.body.rejected[0] && bigTtl.body.rejected[0].reason === 'bad-ttl', 'sync rejeita ttl acima do limite');

  const tooBig = await api('/api/mesh/sync', 'POST', { messages: [envelope({ messageId: 'm-big', payload: 'x'.repeat(5000) })] });
  ok(tooBig.body.rejected[0] && tooBig.body.rejected[0].reason === 'too-large', 'sync rejeita mensagem acima de maxMessageBytes');

  const overBatch = await api('/api/mesh/sync', 'POST', { messages: Array.from({ length: 101 }, (_, i) => envelope({ messageId: `b-${i}` })) });
  ok(overBatch.status === 413, 'sync rejeita lote acima de maxBatchSize');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });
