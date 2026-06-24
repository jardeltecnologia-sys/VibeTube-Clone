const { io } = require('socket.io-client');
const BASE = process.env.BASE || 'http://localhost:3001';
async function api(path, method='GET', token, body){const h={};if(token)h.Authorization=`Bearer ${token}`;if(body)h['Content-Type']='application/json';const r=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});const d=await r.json().catch(()=>null);if(!r.ok)throw new Error(`${path} ${r.status} ${JSON.stringify(d)}`);return d;}
const connect=(t)=>new Promise((res,rej)=>{const s=io(BASE,{auth:{token:t}});s.on('connect',()=>res(s));s.on('connect_error',rej);});
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  ✓',m)):(fail++,console.log('  ✗',m));};
  const ts=Date.now();
  const ana=await api('/api/auth/register','POST',null,{email:`a${ts}@t.com`,password:'secret1',displayName:'Ana'});
  const bru=await api('/api/auth/register','POST',null,{email:`b${ts}@t.com`,password:'secret1',displayName:'Bruno'});
  const carl=await api('/api/auth/register','POST',null,{email:`c${ts}@t.com`,password:'secret1',displayName:'Carlos'});

  // Bruno tem uma inscrição de push (consegue ser acordado mesmo com app fechado)
  await api('/api/push/subscribe','POST',bru.token,{subscription:{endpoint:`https://fake.invalid/${ts}`,keys:{p256dh:'BPxxbStTU0Z9k1pX2W3qkq9d9k1f8mZ8m3c0a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6',auth:'a1b2c3d4e5f6g7h8i9j0k1'}}});

  const sa=await connect(ana.token);
  let anaUnavailable=null, anaEnded=null;
  sa.on('call:unavailable',(d)=>{anaUnavailable=d;});
  sa.on('call:ended',(d)=>{anaEnded=d;});

  // --- Cenário 1: Bruno OFFLINE mas com push -> NÃO deve dar "indisponível" ---
  const callId=`ana-${ts}`;
  sa.emit('call:invite',{to:bru.user.id,callId,media:'audio',chatId:null});
  await wait(600);
  ok(anaUnavailable===null,'App fechado + push: chamador NÃO recebe "indisponível" (segura tocando)');
  ok(anaEnded===null,'App fechado + push: chamada continua tocando (não encerrou)');

  // --- Bruno abre o app (conecta): deve receber a chamada pendente ---
  let bruIncoming=null;
  const sb=io(BASE,{auth:{token:bru.token}});
  sb.on('call:incoming',(d)=>{bruIncoming=d;});
  await new Promise((res,rej)=>{sb.on('connect',res);sb.on('connect_error',rej);});
  await wait(1300);
  ok(bruIncoming && bruIncoming.callId===callId,'Ao abrir o app, a chamada pendente toca (call:incoming entregue)');
  ok(bruIncoming && bruIncoming.from && bruIncoming.from.displayName==='Ana','Chamada pendente traz quem está ligando');

  // --- Cenário 2: Carlos OFFLINE e SEM push -> deve dar "indisponível" na hora ---
  let anaUnavail2=null;
  const sa2=await connect(ana.token);
  sa2.on('call:unavailable',(d)=>{anaUnavail2=d;});
  const callId2=`ana2-${ts}`;
  sa2.emit('call:invite',{to:carl.user.id,callId:callId2,media:'audio',chatId:null});
  await wait(500);
  ok(anaUnavail2 && anaUnavail2.reason==='offline','Sem app e sem push: chamador recebe "indisponível" na hora (não fica esperando)');

  sa.close(); sb.close(); sa2.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
