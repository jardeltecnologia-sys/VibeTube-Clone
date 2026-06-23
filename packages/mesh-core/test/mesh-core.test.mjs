// Unit tests for @vibetube/mesh-core (Phase 2 acceptance criteria):
//   - identity generation
//   - signature sign/verify (+ tamper detection)
//   - E2E encrypt/decrypt roundtrip (+ outsider cannot read)
//   - dedup working
//   - TTL working
//   - serialize/deserialize roundtrip
// Run:  node test/mesh-core.test.mjs   (or: npm test)

import {
  generateDeviceIdentity, publicIdentity, deviceIdMatches,
  serializeIdentity, deserializeIdentity, rotateIdentityKeys,
  createEnvelope, signEnvelope, verifyEnvelope, decrementTTL,
  serializeMessage, deserializeMessage, isExpired, DEFAULT_TTL,
  encryptMessage, decryptMessage,
  createSeenCache, markSeen, hasSeen,
  shouldForward, isForMe,
} from '../src/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };

(async () => {
  // ---------------------------------------------------------------- identity
  const alice = await generateDeviceIdentity({ displayName: 'Alice' });
  const bob = await generateDeviceIdentity({ displayName: 'Bob' });
  const eve = await generateDeviceIdentity({ displayName: 'Eve' });

  ok(alice.deviceId && alice.sign && alice.kx, 'Identidade: gera deviceId + chaves de assinatura e troca');
  ok(alice.deviceId !== bob.deviceId, 'Identidade: deviceIds distintos por dispositivo');
  ok(await deviceIdMatches(alice.deviceId, alice.sign.pub), 'Identidade: deviceId deriva da chave pública de assinatura');
  ok(!(await deviceIdMatches(alice.deviceId, bob.sign.pub)), 'Identidade: deviceId não casa com chave de outro');

  const pub = publicIdentity(alice);
  ok(pub.signPub && pub.kxPub && !('priv' in (pub.sign || {})), 'Identidade pública: só expõe chaves públicas');
  ok(JSON.stringify(pub).indexOf(alice.sign.priv.d) === -1, 'Identidade pública: NÃO vaza a chave privada');

  const round = deserializeIdentity(serializeIdentity(alice));
  ok(round.deviceId === alice.deviceId, 'Identidade: serializa/desserializa preservando o id');

  const rotated = await rotateIdentityKeys(alice);
  ok(rotated.sign.pub !== alice.sign.pub && rotated.createdAt === alice.createdAt, 'Identidade: rotação troca chaves mantendo created_at');

  // ---------------------------------------------------------------- signatures
  const env = createEnvelope({ type: 'chat', roomId: 'sala-1', payload: 'ola mundo' });
  await signEnvelope(env, alice);
  ok(env.fromDeviceId === alice.deviceId && env.signature, 'Assinatura: carimba remetente e assina');
  ok(await verifyEnvelope(env), 'Assinatura: envelope íntegro verifica');

  const tampered = { ...env, payload: 'conteudo trocado' };
  ok(!(await verifyEnvelope(tampered)), 'Assinatura: adulterar o payload invalida a assinatura');

  const spoof = { ...env, fromDeviceId: bob.deviceId };
  ok(!(await verifyEnvelope(spoof)), 'Assinatura: trocar o deviceId (spoof) é detectado');

  // ---------------------------------------------------------------- E2E crypto
  const secret = 'mensagem secreta para a familia';
  const payload = await encryptMessage(secret, alice, publicIdentity(bob).kxPub);
  ok(payload && payload !== secret && payload.indexOf('familia') === -1, 'Cripto: payload cifrado não contém o texto');

  const back = await decryptMessage(payload, bob, publicIdentity(alice).kxPub);
  ok(back === secret, 'Cripto: destinatário correto decifra (roundtrip X25519+AES-GCM)');

  let outsiderFailed = false;
  try { await decryptMessage(payload, eve, publicIdentity(alice).kxPub); }
  catch { outsiderFailed = true; }
  ok(outsiderFailed, 'Cripto: um terceiro (relay intermediário) NÃO consegue ler');

  // ---------------------------------------------------------------- TTL
  ok(env.ttl === DEFAULT_TTL && env.hopCount === 0, 'TTL: começa em DEFAULT_TTL com hopCount 0');
  const hop1 = decrementTTL(env);
  ok(hop1.ttl === DEFAULT_TTL - 1 && hop1.hopCount === 1, 'TTL: decrementa ttl e incrementa hopCount');
  ok(await verifyEnvelope(hop1), 'TTL: assinatura continua válida após decrementar (campos de rota não são assinados)');

  // ---------------------------------------------------------------- dedup
  const seen = createSeenCache();
  ok(!hasSeen(seen, env.messageId), 'Dedup: id desconhecido não foi visto');
  markSeen(seen, env.messageId);
  ok(hasSeen(seen, env.messageId), 'Dedup: após markSeen, o id é reconhecido');

  // ---------------------------------------------------------------- forwarding
  const seen2 = createSeenCache();
  ok(shouldForward(hop1, { selfDeviceId: 'X', seen: seen2 }), 'Forward: mensagem pública fresca é retransmitida');
  const direct = createEnvelope({ type: 'direct', toDeviceId: 'me-device', payload });
  await signEnvelope(direct, alice);
  ok(!shouldForward(direct, { selfDeviceId: 'me-device', seen: seen2 }), 'Forward: se sou o destino, não retransmito (entrego)');
  ok(isForMe(direct, 'me-device'), 'Forward: isForMe detecta destino');
  const dead = decrementTTL({ ...hop1, ttl: 0 });
  ok(!shouldForward(dead, { selfDeviceId: 'X', seen: seen2 }), 'Forward: ttl<=0 não retransmite');
  markSeen(seen2, hop1.messageId);
  ok(!shouldForward(hop1, { selfDeviceId: 'X', seen: seen2 }), 'Forward: duplicada (já vista) não retransmite');
  const old = createEnvelope({ type: 'chat', payload: 'x', lifetimeMs: -1000 });
  await signEnvelope(old, alice);
  ok(isExpired(old) && !shouldForward(old, { selfDeviceId: 'X', seen: createSeenCache() }), 'Forward: expirada não retransmite');

  // ---------------------------------------------------------------- serialize
  const wire = serializeMessage(env);
  const parsed = deserializeMessage(wire);
  ok(parsed.messageId === env.messageId && await verifyEnvelope(parsed), 'Serialização: roundtrip preserva e verifica o envelope');
  let badParse = false;
  try { deserializeMessage('{"version":999}'); } catch { badParse = true; }
  ok(badParse, 'Serialização: versão incompatível é rejeitada');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });
