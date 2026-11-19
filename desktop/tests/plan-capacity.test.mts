import { chatUrl, withConversation } from "./fixtures/conversation.ts";
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {PlanStore} from '../main/research/store.ts';
import {LocalPlans} from '../main/research/plans.ts';
import {chatPlansHandler} from '../main/research/chat-plans.ts';
import {scientificPlan} from './fixtures/scientific-plan.ts';
const origin='http://localhost:5010';
const post=(path:string,body:unknown,from=origin)=>new Request(origin+path,{method:'POST',headers:{origin:from,'content-type':'application/json'},body:JSON.stringify(path.startsWith('/api/chat')?withConversation(body as object):body)});

test('capacity blocks model calls; exact selected plans archive atomically with stale-list protection',async()=>{
 const dir=mkdtempSync('/tmp/delphi-capacity-');const store=new PlanStore(dir);const plans=new LocalPlans(store,dir+'/plans');
 let calls=0;
 const handler=chatPlansHandler({plans,origin,backendUrl:'http://127.0.0.1:8000',authenticate:async()=>true,installation:async()=>'',fetch:async()=>{calls++;return new Response('Unexpected model call',{status:500})}});
 try {
  const original=Array.from({length:3},()=>plans.create({...scientificPlan,evidence:[]},{}));
  const full=await handler(post('/api/chat/stream',{prompt:'Plan the ablation',desktop_mode:'plan'}));
  assert.equal(full!.status,409);assert.equal((await full!.json()).code,'plan_capacity');assert.equal(calls,0);
  assert.equal(store.objects('chat_receipts').length,0);
  const select=(p:typeof original[number])=>({id:p.id,revision:p.revision});
  const selected=original.slice(0,2).map(select);
  assert.equal((await handler(post('/desktop/plans/archive',{selected},'https://evil.example')))!.status,403);
  assert.equal((await handler(post('/desktop/plans/archive',{selected:[selected[0],selected[0]]})))!.status,400);
  assert.equal((await handler(post('/desktop/plans/archive',{selected:[selected[0],{...selected[1],revision:9}]})))!.status,409);
  assert.equal(plans.list().filter(p=>p.archived).length,0);
  // Simulate a storage failure during the batch, after the first write.
  const put=store.put.bind(store);let writes=0;
  store.put=(...args:Parameters<typeof store.put>)=>{if(++writes===2)throw Error('Disk failure');return put(...args)};
  assert.equal((await handler(post('/desktop/plans/archive',{selected})))!.status,500);
  store.put=put;assert.equal(plans.list().filter(p=>p.archived).length,0);
  const archived=await handler(post('/desktop/plans/archive',{selected}));assert.equal(archived!.status,200);
  assert.deepEqual((await archived!.json()).plans.map((p:{id:string})=>p.id),[original[2].id]);
  assert.equal(plans.list().length,3);assert.equal(plans.get(original[0].id).revision,2);
  await handler(post('/api/chat/stream',{prompt:'Plan the ablation',desktop_mode:'plan'}));assert.equal(calls,1);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

test('in-flight requests reserve capacity and release it when the response ends',async()=>{
 const dir=mkdtempSync('/tmp/delphi-reservations-');const store=new PlanStore(dir);const plans=new LocalPlans(store,dir+'/plans');let calls=0;let complete!:()=>void;
 const handler=chatPlansHandler({plans,origin,backendUrl:'http://127.0.0.1:8000',authenticate:async()=>true,installation:async()=>'',fetch:async()=>{calls++;return new Response(new ReadableStream({start(c){complete=()=>{c.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));c.close()}}}),{headers:{'content-type':'text/event-stream'}})}});
 try {
  for(let i=0;i<2;i++)plans.create({...scientificPlan,evidence:[]},{});
  const first=await handler(post('/api/chat/stream',{prompt:'First',desktop_mode:'plan'}));
  const second=await handler(post('/api/chat/stream',{prompt:'Second',desktop_mode:'plan'}));assert.equal(second!.status,409);assert.equal(calls,1);
  complete();await first!.text();
  const capacity=await handler(new Request(origin+'/desktop/plans/capacity'));assert.equal((await capacity!.json()).pending,0);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});
