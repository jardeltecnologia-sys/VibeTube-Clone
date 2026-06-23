const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';
async function api(path, method='GET', token, body){const h={};if(token)h.Authorization=`Bearer ${token}`;if(body)h['Content-Type']='application/json';const r=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});const d=await r.json().catch(()=>null);if(!r.ok)throw new Error(`${path} ${r.status} ${JSON.stringify(d)}`);return d;}
const connect=(t)=>new Promise((res,rej)=>{const s=io(BASE,{auth:{token:t}});s.on('connect',()=>res(s));s.on('connect_error',rej);});
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const sendAck=(s,p)=>new Promise(r=>s.emit('message:send',p,r));
(async()=>{
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  ✓',m)):(fail++,console.log('  ✗',m));};
  const ts=Date.now();
  const ana=await api('/api/auth/register','POST',null,{email:`ta${ts}@t.com`,password:'secret1',displayName:'Ana'});
  const bru=await api('/api/auth/register','POST',null,{email:`tb${ts}@t.com`,password:'secret1',displayName:'Bruno'});
  const sa=await connect(ana.token); const sb=await connect(bru.token);

  // ---- Saved Messages (self chat) ----
  const saved=(await api('/api/chats/saved','POST',ana.token)).chat;
  ok(saved && saved.type==='saved' && /salvas/i.test(saved.title),'Mensagens salvas: cria chat próprio');
  const saved2=(await api('/api/chats/saved','POST',ana.token)).chat;
  ok(saved2.id===saved.id,'Mensagens salvas: reusa o mesmo chat');
  const ackS=await sendAck(sa,{chatId:saved.id,body:'lembrete pra mim',type:'text',clientId:'s1'});
  ok(ackS.ok && ackS.message,'Mensagens salvas: consigo enviar para mim mesmo');

  // ---- Polls ----
  const chat=(await api('/api/chats/direct','POST',ana.token,{userId:bru.user.id})).chat;
  sb.emit('chat:join',{chatId:chat.id});
  let bPoll=null; sb.on('message:new',({message})=>{ if(message.type==='poll') bPoll=message; });
  let bUpd=null; sb.on('poll:update',(d)=>{ bUpd=d; });
  const ackP=await sendAck(sa,{chatId:chat.id,type:'poll',body:JSON.stringify({question:'Pizza ou Sushi?',options:['Pizza','Sushi'],multi:false})});
  ok(ackP.ok && ackP.message.type==='poll' && ackP.message.poll && ackP.message.poll.options.length===2,'Enquete: criada com 2 opções');
  const pid=ackP.message.id;
  await wait(150);
  ok(bPoll && bPoll.poll && bPoll.poll.question==='Pizza ou Sushi?','Enquete: entregue ao outro participante');
  // invalid poll rejected
  const bad=await sendAck(sa,{chatId:chat.id,type:'poll',body:JSON.stringify({question:'x',options:['só uma']})});
  ok(bad.error,'Enquete inválida (1 opção) recusada');
  // votes
  sa.emit('poll:vote',{messageId:pid,option:0}); await wait(120);
  sb.emit('poll:vote',{messageId:pid,option:1}); await wait(150);
  ok(bUpd && bUpd.votes.length===2,'Enquete: dois votos contabilizados');
  // single-choice: changing my vote replaces it
  sa.emit('poll:vote',{messageId:pid,option:1}); await wait(150);
  const anaVotes=bUpd.votes.filter(v=>v.userId===ana.user.id);
  ok(anaVotes.length===1 && anaVotes[0].option===1,'Enquete: escolha única substitui meu voto');
  // toggling same option off
  sa.emit('poll:vote',{messageId:pid,option:1}); await wait(150);
  ok(!bUpd.votes.some(v=>v.userId===ana.user.id),'Enquete: votar de novo na mesma opção remove meu voto');

  // ---- Scheduled messages ----
  let bSched=null; sb.on('message:new',({message})=>{ if(message.body==='ola agendada') bSched=message; });
  const when=Date.now()+2600;
  const ackSch=await sendAck(sa,{chatId:chat.id,type:'text',body:'ola agendada',sendAt:when});
  ok(ackSch.ok && ackSch.scheduled===true,'Agendada: aceita com flag scheduled');
  await wait(1000);
  ok(bSched===null,'Agendada: NÃO entregue antes do horário');
  await wait(2400); // past send time; sweeper (SWEEP_MS=400) delivers
  ok(bSched && bSched.body==='ola agendada','Agendada: entregue após o horário pelo sweeper');

  sa.close(); sb.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
