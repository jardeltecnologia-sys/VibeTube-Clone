// Unit tests for chunked media over the mesh (Stage 2).
//   - splitMedia: chunk count/size/metadata, tiny payload, oversize rejection
//   - MediaReassembler: in-order, out-of-order, duplicates, incomplete
//   - sender isolation (same mediaId from two senders)
//   - end-to-end round trip through a simulated multi-hop relay
// Run:  node test/chunk.test.mjs

import {
  splitMedia, MediaReassembler, DEFAULT_CHUNK_B64, MAX_MEDIA_B64,
} from '../src/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };

// Deterministic base64-ish string of a given length (chars are valid base64).
function b64of(len) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = '';
  for (let i = 0; i < len; i += 1) s += alphabet[i % alphabet.length];
  return s;
}

(async () => {
  // ---------------------------------------------------------------- splitMedia
  const big = b64of(DEFAULT_CHUNK_B64 * 3 + 17);
  const chunks = splitMedia({ mediaId: 'm1', type: 'audio', mime: 'audio/webm', name: 'voz', b64: big });
  ok(chunks.length === 4, 'splitMedia: número de chunks correto (3*size+resto -> 4)');
  ok(chunks.every((c) => c.n === 4), 'splitMedia: cada chunk conhece o total n');
  ok(chunks.map((c) => c.i).join(',') === '0,1,2,3', 'splitMedia: índices sequenciais');
  ok(chunks.every((c) => c.mediaId === 'm1' && c.type === 'audio' && c.mime === 'audio/webm' && c.name === 'voz'),
    'splitMedia: metadados repetidos em cada chunk');
  ok(chunks.map((c) => c.chunk).join('') === big, 'splitMedia: concatenação reconstrói o original');
  ok(chunks.slice(0, 3).every((c) => c.chunk.length === DEFAULT_CHUNK_B64), 'splitMedia: chunks cheios no tamanho alvo');

  const tiny = splitMedia({ mediaId: 't', b64: 'AAAA' });
  ok(tiny.length === 1 && tiny[0].chunk === 'AAAA', 'splitMedia: payload pequeno vira 1 chunk');

  let threw = false;
  try { splitMedia({ mediaId: 'x', b64: b64of(MAX_MEDIA_B64 + 1) }); } catch { threw = true; }
  ok(threw, 'splitMedia: mídia acima do limite é rejeitada');

  let threw2 = false;
  try { splitMedia({ b64: 'AAAA' }); } catch { threw2 = true; }
  ok(threw2, 'splitMedia: exige mediaId');

  // ---------------------------------------------------------------- reassembly in order
  const r1 = new MediaReassembler();
  let done = null;
  for (const c of chunks) done = r1.add(c, 'bob') || done;
  ok(done && done.b64 === big, 'Reassembly: em ordem reconstrói o base64 original');
  ok(done.type === 'audio' && done.mime === 'audio/webm' && done.name === 'voz' && done.mediaId === 'm1',
    'Reassembly: preserva os metadados');

  // ---------------------------------------------------------------- out of order + duplicates
  const r2 = new MediaReassembler();
  const shuffled = [chunks[2], chunks[0], chunks[2], chunks[3], chunks[1], chunks[0]]; // fora de ordem + repetidos
  let done2 = null;
  for (const c of shuffled) done2 = r2.add(c, 'bob') || done2;
  ok(done2 && done2.b64 === big, 'Reassembly: fora de ordem + duplicados reconstrói corretamente');

  // ---------------------------------------------------------------- incomplete -> null
  const r3 = new MediaReassembler();
  let partial = null;
  for (const c of chunks.slice(0, 3)) partial = r3.add(c, 'bob') || partial;
  ok(partial === null, 'Reassembly: incompleto retorna null (segura até completar)');
  partial = r3.add(chunks[3], 'bob');
  ok(partial && partial.b64 === big, 'Reassembly: o último chunk completa a mídia');

  // ---------------------------------------------------------------- sender isolation
  const r4 = new MediaReassembler();
  const aliceChunks = splitMedia({ mediaId: 'm1', type: 'image', mime: 'image/png', name: 'a', b64: b64of(10) });
  const carlChunks = splitMedia({ mediaId: 'm1', type: 'image', mime: 'image/png', name: 'c', b64: b64of(20) });
  // mesmo mediaId, remetentes diferentes -> não podem se misturar
  let da = null, dc = null;
  for (const c of aliceChunks) da = r4.add(c, 'alice') || da;
  for (const c of carlChunks) dc = r4.add(c, 'carlos') || dc;
  ok(da && da.b64 === b64of(10) && da.name === 'a', 'Isolamento: mídia da Alice fica intacta');
  ok(dc && dc.b64 === b64of(20) && dc.name === 'c', 'Isolamento: mídia do Carlos não se mistura (mesmo mediaId)');

  // ---------------------------------------------------------------- end-to-end via relay simulado
  // Origem -> Relay (re-emite cada chunk) -> Destino. Simula multi-hop + dup.
  const src = splitMedia({ mediaId: 'voz9', type: 'audio', mime: 'audio/webm', name: 'recado', b64: b64of(8000) });
  const dest = new MediaReassembler();
  let received = null;
  for (const c of src) {
    // o relay encaminha e às vezes duplica
    received = dest.add(c, 'origem') || received;
    if (c.i % 2 === 0) received = dest.add(c, 'origem') || received; // duplicata do relay
  }
  ok(received && received.b64 === b64of(8000), 'Ponta-a-ponta: áudio multi-hop com duplicatas reassembla 100%');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
