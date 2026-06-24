// Unit tests for mesh call signaling (Stage 3 foundation).
//   - buildCallSignal: shape per type, audio/video normalization, carries `from`
//   - routeCallSignal: maps each type to the right CallManager handler + payload
//   - rejects malformed/unknown signals
//   - round trip: build -> route reproduces the original intent
// Run:  node test/callsignal.test.mjs

import { buildCallSignal, routeCallSignal, CALL_SIGNAL_KIND } from '../src/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };

(async () => {
  ok(CALL_SIGNAL_KIND === 'csig', 'kind do sinal de chamada é "csig"');

  // ---------------------------------------------------------------- buildCallSignal
  const inv = buildCallSignal('invite', { callId: 'c1', media: 'video', from: { id: 'u1', displayName: 'Ana' } });
  ok(inv.t === 'invite' && inv.callId === 'c1' && inv.media === 'video', 'build invite: tipo/callId/media corretos');
  ok(inv.from && inv.from.id === 'u1', 'build invite: carrega o perfil de quem liga');
  ok(buildCallSignal('invite', { callId: 'c', media: 'xyz' }).media === 'audio', 'build invite: media inválida vira "audio"');

  const sdp = buildCallSignal('sdp', { callId: 'c1', sdp: { type: 'offer', sdp: 'v=0' } });
  ok(sdp.t === 'sdp' && sdp.sdp.type === 'offer', 'build sdp: carrega o SDP');
  const ice = buildCallSignal('ice', { callId: 'c1', candidate: { candidate: 'x' } });
  ok(ice.t === 'ice' && ice.candidate.candidate === 'x', 'build ice: carrega o candidate');
  ok(buildCallSignal('end', { callId: 'c1' }).t === 'end', 'build end: ok');

  // ---------------------------------------------------------------- routeCallSignal
  const r1 = routeCallSignal(inv, 'origem1');
  ok(r1.handler === '_onIncoming' && r1.payload.callId === 'c1' && r1.payload.media === 'video', 'route invite -> _onIncoming');
  ok(r1.payload.from.id === 'u1', 'route invite: preserva quem liga');

  // invite sem `from` cai no fallback do remetente da malha
  const r1b = routeCallSignal({ t: 'invite', callId: 'c2', media: 'audio' }, 'origemX');
  ok(r1b.payload.from.id === 'origemX', 'route invite sem from: usa a origem da malha como identidade');

  ok(routeCallSignal(buildCallSignal('accept', { callId: 'c1' })).handler === '_onAccepted', 'route accept -> _onAccepted');
  ok(routeCallSignal(buildCallSignal('reject', { callId: 'c1' })).handler === '_onRejected', 'route reject -> _onRejected');
  ok(routeCallSignal(buildCallSignal('end', { callId: 'c1' })).handler === '_onEnded', 'route end -> _onEnded');

  const rs = routeCallSignal(sdp);
  ok(rs.handler === '_onSdp' && rs.payload.sdp.type === 'offer', 'route sdp -> _onSdp com o SDP');
  const ri = routeCallSignal(ice);
  ok(ri.handler === '_onIce' && ri.payload.candidate.candidate === 'x', 'route ice -> _onIce com o candidate');

  // ---------------------------------------------------------------- rejeições
  ok(routeCallSignal(null) === null, 'route: null é rejeitado');
  ok(routeCallSignal({ t: 'invite' }) === null, 'route: sem callId é rejeitado');
  ok(routeCallSignal({ t: 'desconhecido', callId: 'c' }) === null, 'route: tipo desconhecido é rejeitado');
  ok(routeCallSignal({ t: 'sdp', callId: 'c' }) === null, 'route: sdp sem corpo é rejeitado');
  ok(routeCallSignal({ t: 'ice', callId: 'c' }) === null, 'route: ice sem candidate é rejeitado');

  // ---------------------------------------------------------------- round trip completo de uma chamada
  const steps = [
    ['invite', { callId: 'k', media: 'audio', from: { id: 'caller' } }, '_onIncoming'],
    ['accept', { callId: 'k' }, '_onAccepted'],
    ['sdp', { callId: 'k', sdp: { type: 'offer', sdp: 'a' } }, '_onSdp'],
    ['sdp', { callId: 'k', sdp: { type: 'answer', sdp: 'b' } }, '_onSdp'],
    ['ice', { callId: 'k', candidate: { candidate: 'c' } }, '_onIce'],
    ['end', { callId: 'k' }, '_onEnded'],
  ];
  let allOk = true;
  for (const [t, args, expected] of steps) {
    const routed = routeCallSignal(buildCallSignal(t, args), 'peer');
    if (!routed || routed.handler !== expected || routed.payload.callId !== 'k') allOk = false;
  }
  ok(allOk, 'Round trip: convite->aceite->sdp->ice->fim mapeiam todos para o handler certo');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
