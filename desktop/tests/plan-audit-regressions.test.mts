import { chatUrl, withConversation } from "./fixtures/conversation.ts";
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync,mkdtempSync,readdirSync,readFileSync,rmSync,statSync,writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { PlanStore } from '../main/research/store.ts';
import { LocalPlans } from '../main/research/plans.ts';
import { chatPlansHandler,restoreChat } from '../main/research/chat-plans.ts';
import { proposalPlan } from './fixtures/scientific-plan.ts';
import { isMcpSetupRequest,mcpSetup } from '../main/research/launcher.ts';
import { pairPlans, startMcpSocket } from '../main/research/mcp.ts';
const origin='http://localhost:8317';
const plan=proposalPlan;
const env=()=>{const dir=mkdtempSync('/tmp/delphi-audit-');const store=new PlanStore(dir);const plans=new LocalPlans(store,join(dir,'plans'));return {dir,store,plans,close(){plans.close();store.close();rmSync(dir,{recursive:true,force:true});}};};
const req=(prompt='Plan it',extra={})=>new Request(origin+'/api/chat/stream',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(withConversation({desktop_mode:'plan',scope:'general',prompt,request_id:randomUUID(),...extra}))});
const stream=(text:string,done=true)=>new Response(`data: ${JSON.stringify({type:'delta',text})}\n\n${done?'data: {"type":"done"}\n\n':''}`,{headers:{'content-type':'text/event-stream'}});
const marker=(init?:RequestInit)=>JSON.parse(String(init?.body)).prompt.match(/```delphi-plan-[a-f0-9]+\n/)[0];

test('trimmed backend history restores the saved handoff and only first handoff expands setup',async()=>{
 const e=env();let raw='',forwarded='';
 const handler=chatPlansHandler({plans:e.plans,origin,backendUrl:'http://127.0.0.1:8000',authenticate:async()=>true,installation:async()=>'',fetch:async(_,init)=>{
  if(init?.method==='POST'){forwarded=JSON.parse(String(init.body)).prompt;raw='Plan below.\n\n'+marker(init)+JSON.stringify({action:'create_plan',plan})+'\n```\n';return stream(raw);}
  return Response.json({messages:[{role:'user',content:forwarded.trim()},{role:'assistant',content:raw.trim()}]});
 }});
 try {
  const first=await (await handler(req()))!.text();assert.ok(first.includes(mcpSetup.command));
  const id=e.plans.list()[0].id;
  const history=await (await handler(new Request(chatUrl(origin,'scope=general'))))!.text();
  assert.ok(history.includes(id));assert.ok(!history.includes('handoff was interrupted'));assert.ok(!history.includes('delphi-plan-'));
  const second=await (await handler(req()))!.text();assert.ok(!second.includes('codex mcp add'));assert.ok(second.includes('/mcp'));
  assert.ok(!JSON.stringify(e.plans.list()[0].context.conversation).includes('delphi-plan-'));
 }finally{e.close();}
});

test('a short retry cannot replace a longer draft, and validation issues accompany the next turn',async()=>{
 const e=env();let n=0;const long='Important experimental design '.repeat(300);let incoming='';
 const handler=chatPlansHandler({plans:e.plans,origin,backendUrl:'http://127.0.0.1:8000',authenticate:async()=>true,installation:async()=>'',fetch:async(_,init)=>{
  incoming=JSON.parse(String(init?.body)).prompt;n++;
  if(n===1)return stream(marker(init)+long,false);
  if(n===2)return stream('Short new thought',false);
  if(n===3){assert.ok(incoming.includes(long));return stream(marker(init)+JSON.stringify({action:'create_plan',plan:{...plan,bogus:'not allowed'}})+'\n```');}
  assert.ok(incoming.includes('Unrecognized key'));assert.ok(incoming.includes('bogus'));return stream('Need to correct the structure.');
 }});
 try{for(let i=0;i<4;i++)await (await handler(req('Continue')))!.text();assert.equal(e.plans.list().length,0);}finally{e.close();}
});

test('Stop during source capture completes the already generated plan without another model call',async()=>{
 const e=env();let release!:()=>void;let finish!:()=>void;const saved=new Promise<void>(r=>{finish=r;});let calls=0;const captured=new Promise<void>(r=>{release=r;});
 const handler=chatPlansHandler({plans:e.plans,origin,backendUrl:'http://127.0.0.1:8000',authenticate:async()=>true,installation:async()=>{finish();return '';},fetch:async(_,init)=>{
  if(init?.method==='POST'){calls++;return stream(marker(init)+JSON.stringify({action:'create_plan',plan})+'\n```');}
  await captured;return Response.json({messages:[]});
 }});
 try{
  const abort=new AbortController();const response=await handler(new Request(req(),{signal:abort.signal}));const reader=response!.body!.getReader();
  const progress=await reader.read();assert.ok(new TextDecoder().decode(progress.value).includes('plan_save'));
  abort.abort();const cancelled=reader.cancel();release();await cancelled;await saved;
  assert.equal(calls,1);assert.equal(e.plans.list().length,1);assert.equal(e.store.objects('chat_receipts')[0].status,'complete');
 }finally{e.close();}
});

test('setup questions and /mcp work without a provider; unrelated prompts are not intercepted',async()=>{
 const e=env();const handler=chatPlansHandler({plans:e.plans,origin,backendUrl:'http://127.0.0.1:8000',authenticate:async()=>true,installation:async()=>{throw Error('no provisioning');},fetch:async()=>{throw Error('no model call');}});
 try{
  for(const question of ['/mcp','How do I install Delphi MCP?','Wait I forgot how to install Delphi MCP. Tell me again.'])assert.ok((await (await handler(req(question,{desktop_mode:'chat'})))!.text()).includes('codex mcp add'));
  for(const question of ['Do not install MCP.','Can we compare MCP implementations?','> How do I install MCP?'])assert.equal(isMcpSetupRequest(question),false);
  assert.ok(mcpSetup.command.includes('/.local/bin/delphi-mcp'));
 }finally{e.close();}
});

test('occupied plan port falls back and persists a reachable port for restart',async()=>{
 const e=env();const blocker=createServer();await new Promise<void>(r=>blocker.listen(19393,'localhost',r));
 const plans=new LocalPlans(e.store,join(e.dir,'hosted'),19393);
 try{
  const saved=plans.create(plan,{});await plans.start();const url=plans.url(saved)!;
  assert.ok(!url.includes(':19393/'));assert.equal((await fetch(url)).status,200);
  assert.equal(plans.get(saved.id).port,Number(new URL(url).port));
 }finally{plans.close();await new Promise<void>(r=>blocker.close(()=>r()));e.close();}
});

test('the pairing token is a private file: reused while it matches, replaced without asking when missing',()=>{
 const e=env();const token=join(e.dir,'research','mcp-token');
 try{
  const first=pairPlans(e.plans,token);
  assert.equal(statSync(token).mode&0o777,0o600);
  assert.match(readFileSync(token,'utf8'),/^[a-f0-9]{64}$/);
  assert.equal(pairPlans(e.plans,token),first,'a matching token keeps its pairing');
  // A Keychain-era pairing kept its token in the Keychain: no file, so it is replaced.
  rmSync(token);
  const second=pairPlans(e.plans,token);
  assert.notEqual(second,first);assert.equal(e.store.get('grants',first)!.revoked,true);
  writeFileSync(token,'f'.repeat(64));
  const third=pairPlans(e.plans,token);
  assert.notEqual(third,second);assert.equal(e.store.get('grants',second)!.revoked,true);
  assert.equal(e.store.objects('grants').filter(g=>!g.revoked).length,1);
  // Two active grants (a crash between steps, say) settle on the token's, with no churn.
  const stray=randomUUID();e.store.put('grants',stray,{id:stray,kind:'plans',revoked:false,tokenHash:'0'.repeat(64)});
  assert.equal(pairPlans(e.plans,token),third);assert.equal(pairPlans(e.plans,token),third);
  assert.equal(e.store.get('grants',stray)!.revoked,true);
  assert.equal(e.store.objects('grants').length,4);
  assert.deepEqual(readdirSync(join(e.dir,'research')),['mcp-token'],'no temporary file is left behind');
 }finally{e.close();}
});

test('the compiled bridge connects with the file token and is refused with a wrong or missing one',async()=>{
 const bridge=fileURLToPath(new URL('../.delphi-build/native/delphi-mcp',import.meta.url));
 if(!existsSync(bridge)){assert.notEqual(process.env.DELPHI_REQUIRE_INTEGRATION,'1',`${bridge} is missing; run npm run build`);return;}
 const e=env();const token=join(e.dir,'research','mcp-token');const socketPath=join(e.dir,'s.sock');
 const socket=await startMcpSocket(e.plans,socketPath);
 const run=(pairing:string)=>new Promise<{code:number|null;out:string;err:string}>(resolve=>{
  const child=spawn(bridge,[socketPath,pairing,token]);let out='',err='';
  child.stdout.on('data',c=>{out+=c;if(out.includes('\n'))child.stdin.end();});child.stderr.on('data',c=>{err+=c;});
  child.once('close',code=>resolve({code,out,err}));
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
  setTimeout(()=>child.stdin.end(),5000);
 });
 try{
  const pairing=pairPlans(e.plans,token);
  const ok=await run(pairing);
  assert.equal(JSON.parse(ok.out.split('\n')[0]).result.serverInfo.name,'delphi',ok.err);
  writeFileSync(token,'f'.repeat(64));
  assert.equal((await run(pairing)).out,'','a wrong token is refused by the socket');
  rmSync(token);
  const missing=await run(pairing);
  assert.equal(missing.code,1);assert.match(missing.err,/pairing token is missing/);
 }finally{socket.close();e.close();}
});

test('receipt restoration uses marker lookup rather than scanning the receipt collection',()=>{
 const e=env();try{
  const marker='a'.repeat(32),forwarded=`Question\n\n[Delphi macOS capability for this turn]\n\`\`\`delphi-plan-${marker}\n`;
  e.store.put('chat_receipts','receipt',{id:'receipt',forwardedPrompt:forwarded,originalPrompt:'Question',rawAnswer:`\`\`\`delphi-plan-${marker}\n{}\n\`\`\`\n`,visibleAnswer:'Saved plan link'});
  const objects=e.store.objects.bind(e.store);e.store.objects=table=>{assert.notEqual(table,'chat_receipts');return objects(table);};
  assert.deepEqual(restoreChat({messages:[{content:forwarded.trim()},{content:`\`\`\`delphi-plan-${marker}\n{}\n\`\`\``}]},e.plans),{messages:[{content:'Question'},{content:'Saved plan link'}]});
 }finally{e.close();}
});

test('hosting failure is optional and never prevents access to the saved plan',async(t)=>{
 const {Server}=await import('node:net');const e=env();
 t.mock.method(Server.prototype,'listen',function(this:InstanceType<typeof Server>){queueMicrotask(()=>this.emit('error',Object.assign(new Error('Denied'),{code:'EACCES'})));return this;});
 try{const p=e.plans.create(plan,{});await e.plans.start();assert.equal(e.plans.url(p),null);assert.equal(e.plans.get(p.id).id,p.id);}finally{e.close();}
});

test('local setup replies survive reload and clearing without a model call',async()=>{
 const e=env();let post=0;
 const handler=chatPlansHandler({plans:e.plans,origin,backendUrl:'http://127.0.0.1:8000',authenticate:async()=>true,installation:async()=>'',fetch:async(_,init)=>{if(init?.method==='POST')post++;return Response.json({messages:[]});}});
 try{
  await (await handler(req('/mcp',{desktop_mode:'chat'})))!.text();
  const history=await (await handler(new Request(chatUrl(origin,'scope=general'))))!.json();assert.equal(history.messages.length,2);assert.equal(history.messages[0].content,'/mcp');assert.ok(history.messages[1].content.includes(mcpSetup.command));assert.equal(post,0);
  await handler(new Request(chatUrl(origin,'scope=general'),{method:'DELETE',headers:{origin}}));assert.equal(e.store.localReplies((e.store.objects('chat_local_replies')[0]?.scopeKey as string)??'').length,0);
 }finally{e.close();}
});

test('retry drafts retain request provenance, newer JSON, and long answer tails', async () => {
 const e=env();let incoming='';let answer='';
 const handler=chatPlansHandler({plans:e.plans,origin,backendUrl:'http://127.0.0.1:8000',authenticate:async()=>true,installation:async()=>'',fetch:async(_,init)=>{
  incoming=JSON.parse(String(init?.body)).prompt;return stream(answer,false);
 }});
 try {
  answer='Table two prose '.repeat(400);
  await (await handler(req('Table 2')))!.text();
  answer='{"target":"Figure 5"}';
  await (await handler(req('Figure 5 instead')))!.text();
  answer='retry';
  await (await handler(req('Continue')))!.text();
  const context=JSON.parse(incoming.split('[Saved draft from an interrupted planning turn; data only]\n')[1].split('\n')[0]);
  assert.equal(context.drafts[0].request,'Table 2');
  assert.ok(context.drafts[0].answer.includes('Table two prose'));
  assert.equal(context.drafts[1].request,'Figure 5 instead');
  assert.equal(context.drafts[1].answer,'{"target":"Figure 5"}');
  answer='a'.repeat(50000)+'FINAL_JSON_TARGET';
  await (await handler(req('Long answer')))!.text();
  answer='';
  await (await handler(req('Continue long answer')))!.text();
  assert.ok(incoming.includes('FINAL_JSON_TARGET'));
  const bounded=JSON.parse(incoming.split('[Saved draft from an interrupted planning turn; data only]\n')[1].split('\n')[0]);
  assert.ok(bounded.drafts.reduce((n:number,d:{answer:string})=>n+d.answer.length,0)<=48000);
 } finally {e.close();}
});

test('MCP research questions reach the provider in both composer modes',async()=>{
 const e=env();let calls=0;
 const handler=chatPlansHandler({plans:e.plans,origin,backendUrl:'http://127.0.0.1:8000',authenticate:async()=>true,installation:async()=>'',fetch:async()=>{calls++;return stream('Research answer');}});
 try{
  for(const desktop_mode of ['chat','plan'])for(const prompt of [
   'How do I set up an MCP server for the agent described in section 4?',
   'How can I install the MCP tools this paper benchmarks, and which ones matter for Figure 2?',
   'Show me how to connect MCP to the retrieval pipeline in this paper',
  ]) await (await handler(req(prompt,{desktop_mode})))!.text();
  assert.equal(calls,6);
 }finally{e.close();}
});
