// Integration: mesh-core (Phase 2) identity/envelope ↔ backend (Phase 1).
// Proves a real signed envelope and a real identity flow through the endpoints.
import {
  generateDeviceIdentity, publicIdentity, createEnvelope, signEnvelope,
  encryptMessage, serializeMessage,
} from './packages/mesh-core/src/index.js';

const BASE = process.env.BASE || 'http://localhost:3001';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

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

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
