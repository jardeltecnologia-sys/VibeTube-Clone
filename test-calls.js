const { io } = require('socket.io-client');
const BASE = 'http://localhost:3001';
async function api(path, method='GET', token, body){
  const h={};
  if(token) h.Authorization=`Bearer ${token}`;
  if(body) h['Content-Type']='application/json';
  const r=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>null);
  if(!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(d)}`);
  return d;
}
const connect=(t)=>new Promise((res,rej)=>{const s=io(BASE,{auth:{token:t}});s.on('connect',()=>res(s));s.on('connect_error',rej);});
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  let pass=0,fail=0;
  const ok=(c,m)=>{c?(pass++,console.log('  ✓',m)):(fail++,console.log('  ✗',m));};
  const ts=Date.now();
  const ana=await api('/api/auth/register','POST',null,{email:`ca${ts}@t.com`,password:'secret1',displayName:'Ana'});
  const bru=await api('/api/auth/register','POST',null,{email:`cb${ts}@t.com`,password:'secret1',displayName:'Bruno'});
  const sa=await connect(ana.token);
  const sb=await connect(bru.token);

  // -- Test 1: Ana calls Bruno --
  let bruIncoming = null;
  sb.on('call:incoming', (d) => { bruIncoming = d; console.log('  [info] Bruno received call:incoming', JSON.stringify(d)); });
  let anaUnavail = null;
  sa.on('call:unavailable', (d) => { anaUnavail = d; console.log('  [info] Ana got call:unavailable', JSON.stringify(d)); });
  let anaAccepted = null;
  sa.on('call:accepted', (d) => { anaAccepted = d; console.log('  [info] Ana got call:accepted'); });
  let bruSdp = null;
  sb.on('call:sdp', (d) => { bruSdp = d; console.log('  [info] Bruno got call:sdp type=', d.sdp && d.sdp.type); });
  let anaSdp = null;
  sa.on('call:sdp', (d) => { anaSdp = d; console.log('  [info] Ana got call:sdp type=', d.sdp && d.sdp.type); });
  let bruIce = [];
  sb.on('call:ice', (d) => { bruIce.push(d); console.log('  [info] Bruno got call:ice'); });
  let anaIce = [];
  sa.on('call:ice', (d) => { anaIce.push(d); console.log('  [info] Ana got call:ice'); });
  let bruEnded = null;
  sb.on('call:ended', (d) => { bruEnded = d; console.log('  [info] Bruno got call:ended'); });
  let anaEnded = null;
  sa.on('call:ended', (d) => { anaEnded = d; console.log('  [info] Ana got call:ended'); });
  let bruRejected = null;
  sa.on('call:rejected', (d) => { bruRejected = d; console.log('  [info] Ana got call:rejected'); });

  const callId = `ana-${Date.now()}`;
  sa.emit('call:invite', { to: bru.user.id, callId, media: 'audio' });
  await wait(500);

  ok(bruIncoming !== null, 'call:incoming recebido pelo Bruno');
  ok(!anaUnavail, 'sem call:unavailable (Bruno está online)');
  ok(bruIncoming && bruIncoming.callId === callId, 'callId correto na chamada recebida');

  // Bruno accepts
  if (bruIncoming) {
    sb.emit('call:accept', { to: ana.user.id, callId: bruIncoming.callId });
    await wait(300);
    ok(anaAccepted !== null, 'call:accepted chegou para Ana');

    // Ana sends SDP (offer)
    const fakeOffer = { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
    sa.emit('call:sdp', { to: bru.user.id, callId, sdp: fakeOffer });
    await wait(300);
    ok(bruSdp !== null, 'SDP offer chegou para Bruno');
    ok(bruSdp && bruSdp.sdp && bruSdp.sdp.type === 'offer', 'tipo correto do SDP');

    // Bruno sends SDP (answer)
    const fakeAnswer = { type: 'answer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
    sb.emit('call:sdp', { to: ana.user.id, callId, sdp: fakeAnswer });
    await wait(300);
    ok(anaSdp !== null, 'SDP answer chegou para Ana');

    // ICE exchange
    const fakeIce = { candidate: 'candidate:0 1 UDP 2122252543 192.168.1.1 56789 typ host', sdpMid: 'audio', sdpMLineIndex: 0 };
    sa.emit('call:ice', { to: bru.user.id, callId, candidate: fakeIce });
    await wait(200);
    ok(bruIce.length > 0, 'ICE candidate chegou para Bruno');

    // End call
    sa.emit('call:end', { to: bru.user.id, callId });
    await wait(300);
    ok(bruEnded !== null, 'call:ended chegou para Bruno');
  }

  sa.close(); sb.close();
  console.log(`\nRESULTO: ${pass} passou, ${fail} falhou`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO', e); process.exit(2); });
