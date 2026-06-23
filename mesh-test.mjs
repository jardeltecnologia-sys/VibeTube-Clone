// Protocol-level tests for the mesh layer. Runs the real MeshManager in Node
// with an in-memory transport (no WebRTC), wiring links by hand to build
// topologies and asserting multi-hop delivery, dedup, TTL, store-and-forward,
// SOS flooding and ACKs.  Run:  node mesh-test.mjs

import { MeshManager } from './public/js/mesh.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function node(id) {
  const m = new MeshManager({ selfId: id, sendSignal: () => {}, iceServers: [] });
  m.setEnabled(true);
  m.inbox = [];
  m.sosInbox = [];
  m.delivered = [];
  m.addEventListener('message', (e) => m.inbox.push(e.detail));
  m.addEventListener('sos', (e) => m.sosInbox.push(e.detail));
  m.addEventListener('delivered', (e) => m.delivered.push(e.detail.id));
  return m;
}

// Bidirectional link between two nodes via an async in-memory channel.
function link(a, b, { drop = false } = {}) {
  if (drop) return;
  a.addLink(b.selfId, (raw) => setTimeout(() => b.receiveFrame(a.selfId, raw), 1), 'mem');
  b.addLink(a.selfId, (raw) => setTimeout(() => a.receiveFrame(b.selfId, raw), 1), 'mem');
}
function unlink(a, b) { a.removeLink(b.selfId); b.removeLink(a.selfId); }

(async () => {
  // ---- Multi-hop: A — B — C (A and C not directly linked) ----
  {
    const A = node('A'), B = node('B'), C = node('C');
    link(A, B); link(B, C);
    A.sendMessage('C', { text: 'oi familia' });
    await wait(80);
    ok(C.inbox.length === 1 && C.inbox[0].data.text === 'oi familia', 'Multi-salto: A→B→C entrega ao destino');
    ok(B.inbox.length === 0, 'Multi-salto: o nó intermediário (B) NÃO exibe a mensagem alheia');
    ok(A.delivered.length === 1, 'Multi-salto: origem (A) recebe ACK de entrega de volta');
  }

  // ---- Dedup: a diamond A—B—D and A—C—D must deliver once at D ----
  {
    const A = node('A'), B = node('B'), C = node('C'), D = node('D');
    link(A, B); link(A, C); link(B, D); link(C, D);
    A.sendMessage('D', { text: 'uma vez só' });
    await wait(120);
    ok(D.inbox.length === 1, 'Dedup: mensagem que chega por dois caminhos é entregue uma única vez');
  }

  // ---- TTL: a long line drops the message before it arrives ----
  {
    const nodes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map(node);
    for (let i = 0; i < nodes.length - 1; i++) link(nodes[i], nodes[i + 1]);
    // DEFAULT_TTL is 8; the 12-node line is longer than TTL, so the last node
    // must NOT receive it.
    nodes[0].sendMessage('L', { text: 'longe demais' });
    await wait(200);
    ok(nodes[nodes.length - 1].inbox.length === 0, 'TTL: mensagem expira em rede mais longa que o limite de saltos');
  }

  // ---- Store-and-forward: send while target unreachable, then connect ----
  {
    const A = node('A'), B = node('B'), C = node('C');
    link(A, B); // C is not connected yet
    A.sendMessage('C', { text: 'guardada' });
    await wait(60);
    ok(C.inbox.length === 0, 'Store-and-forward: sem caminho, não entrega ainda');
    ok(A.status().held >= 1 || B.status().held >= 1, 'Store-and-forward: a mensagem fica retida aguardando rota');
    link(B, C); // a path to C appears
    await wait(120);
    ok(C.inbox.length === 1 && C.inbox[0].data.text === 'guardada', 'Store-and-forward: entrega quando surge uma rota');
  }

  // ---- SOS: floods the whole connected component ----
  {
    const A = node('A'), B = node('B'), C = node('C'), D = node('D');
    link(A, B); link(B, C); link(C, D);
    A.sos({ name: 'Ana', text: 'Preciso de ajuda!', coords: { lat: -22.9, lon: -43.2 } });
    await wait(150);
    ok(B.sosInbox.length === 1 && C.sosInbox.length === 1 && D.sosInbox.length === 1, 'SOS: alcança todos os nós da malha (flood)');
    ok(D.sosInbox[0].data.coords && D.sosInbox[0].data.coords.lat === -22.9, 'SOS: carrega a localização até a borda da malha');
    ok(A.sosInbox.length === 0, 'SOS: a própria origem não se auto-notifica');
  }

  // ---- Disabled mesh ignores frames ----
  {
    const A = node('A'), B = node('B');
    link(A, B);
    B.setEnabled(false);
    A.sendMessage('B', { text: 'ninguém em casa' });
    await wait(60);
    ok(B.inbox.length === 0, 'Mesh desativada: ignora frames recebidos');
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });
