// Integration: mesh-core (Phase 2) identity/envelope ↔ backend (Phase 1).
// Proves a real signed envelope and a real identity flow through the endpoints.
import {
  generateDeviceIdentity, publicIdentity, createEnvelope, signEnvelope, verifyEnvelope,
  encryptMessage, serializeMessage,
} from './packages/mesh-core/src/index.js';

const BASE = process.env.BASE || 'http://localhost:3001';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(BASE + p).then(r => r.json());

const alice = await generateDeviceIdentity({ displayName: 'Alice' });
const bob = await generateDeviceIdentity({ displayName: 'Bob' });

// register-device with a real public identity
const pa = publicIdentity(alice);
const reg = await post('/api/mesh/register-device', { deviceId: pa.deviceId, publicKey: { signPub: pa.signPub, kxPub: pa.kxPub }, displayName: pa.displayName });
ok(reg.ok && reg.deviceId === pa.deviceId, 'register-device aceita identidade real do mesh-core');

// build a real signed, encrypted envelope and sync it
const payload = await encryptMessage('familia, estou bem', alice, publicIdentity(bob).kxPub);
const env = createEnvelope({ type: 'direct', toDeviceId: bob.deviceId, payload, ttl: 5 });
await signEnvelope(env, alice);
const parsed = JSON.parse(serializeMessage(env));
const sync = await post('/api/mesh/sync', { deviceId: pa.deviceId, messages: [parsed] });
ok(sync.accepted.includes(env.messageId), 'sync aceita envelope assinado real do mesh-core');

// dedup on resend
const sync2 = await post('/api/mesh/sync', { deviceId: pa.deviceId, messages: [parsed] });
ok(sync2.duplicates.includes(env.messageId), 'sync deduplica o mesmo envelope real');

// ---- Server bridge: pull (A → servidor → B) ----
const pb = publicIdentity(bob);
// Bob pulls from cursor 0, excluding his own device — should receive Alice's envelope.
const pullB = await get(`/api/mesh/pull?since=0&deviceId=${encodeURIComponent(pb.deviceId)}`);
const got = (pullB.messages || []).find((m) => m.messageId === env.messageId);
ok(Boolean(got), 'pull: Bob recebe o envelope que Alice sincronizou (bridge via servidor)');
ok(got && await verifyEnvelope(got), 'pull: envelope puxado mantém assinatura válida (mesh-core)');

// Pulling again from the advanced cursor returns nothing new.
const pullB2 = await get(`/api/mesh/pull?since=${pullB.cursor}&deviceId=${encodeURIComponent(pb.deviceId)}`);
ok((pullB2.messages || []).length === 0, 'pull: cursor avança e não reentrega o que já veio');

// Alice pulling with her own deviceId must NOT get her own message back.
const pullA = await get(`/api/mesh/pull?since=0&deviceId=${encodeURIComponent(pa.deviceId)}`);
ok(!(pullA.messages || []).some((m) => m.messageId === env.messageId), 'pull: origem não recebe a própria mensagem de volta');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
