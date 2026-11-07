import { chatUrl, withConversation } from "./fixtures/conversation.ts";
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PlanStore } from '../main/research/store.ts';
import { LocalPlans, scientificV3 } from '../main/research/plans.ts';
import { proposalPlan, scientificPlan } from './fixtures/scientific-plan.ts';
import { createMcp } from '../main/research/mcp.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const { monitoring, constraints, openQuestions, ...base } = scientificPlan;
const draft = { ...base, version: 3, reference: [{ sourceId: 'paper1', target: 'Figure 2', summary: 'A controlled comparison of transitions.', pages: [4], passages: [{location: 'Page 4', excerpt: 'Temporal context distinguishes flashes from cuts.'}] }], decisions: [{ choice: 'Batch size', setting: '256 examples', basis: 'proposed', reason: 'A fixed reproducible baseline, not a reported setting.' }] };
test('Reference precedes the design, unavailable figures are explicit, and decisions replace unresolved questions', () => {
  const dir=mkdtempSync('/tmp/delphi-reference-');const store=new PlanStore(dir);const plans=new LocalPlans(store,join(dir,'plans'));
  try {
    const p=plans.create(draft,{documents:[{id:'paper1',title:'Source document',text:'Temporal context distinguishes flashes from cuts.'}]});
    const html=plans.html(p);
    assert.ok(html.indexOf('<h2>1. Reference') < html.indexOf('2. Scientific goal'));
    for(const text of ['Source document','Corresponding source text','Implementation decisions','256 examples','Requested source image unavailable'])assert.ok(html.includes(text));
    for(const text of ['<blockquote>','Monitoring and deliverables','Resolve before proceeding','Constraints and open questions'])assert.ok(!html.includes(text));
    assert.throws(()=>scientificV3.parse({...draft,monitoring}));
    assert.throws(()=>plans.create({...draft,reference:[{...draft.reference[0],sourceId:'missing'}]},p.context),/not captured/);
  } finally { store.close();rmSync(dir,{recursive:true,force:true}); }
});
test('MCP exposes image metadata with the plan and actual images through source reads',async()=>{
  const dir=mkdtempSync('/tmp/delphi-reference-mcp-');const store=new PlanStore(dir);const plans=new LocalPlans(store,join(dir,'plans'));
  store.put('grants','test',{id:'test',kind:'plans',revoked:false});
  const p=plans.create(draft,{documents:[{id:'paper1',title:'Source',text:'Temporal context distinguishes flashes from cuts.'}],referenceImages:[{sourceId:'paper1',page:4,data:'aW1hZ2U='}]});
  const server=createMcp(plans,'test');const client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a),client.connect(b)]);
    const read=await client.callTool({name:'get_plan',arguments:{plan_id:p.id}});
    assert.ok(!JSON.stringify(read).includes('aW1hZ2U='));
    const image=await client.callTool({name:'read_plan_source',arguments:{plan_id:p.id,index:0,page:4}});
    assert.deepEqual((image.content as any[])[1],{type:'image',mimeType:'image/png',data:'aW1hZ2U='});
    assert.equal((await client.callTool({name:'read_plan_source',arguments:{plan_id:p.id,index:0,page:5}})).isError,true);
  } finally { await client.close();await server.close();store.close();rmSync(dir,{recursive:true,force:true}); }
});

test('source page rendering is bounded and returns an actual PNG', async () => {
  const { spawnSync } = await import('node:child_process');
  const { renderReferencePages } = await import('../main/research/pdf-reference.ts');
  const python = new URL('../.delphi-build/python/bin/python3', import.meta.url).pathname;
  const generated = spawnSync(python, ['-c', "import pypdfium2 as p,sys,io; d=p.PdfDocument.new(); d.new_page(120,100); b=io.BytesIO(); d.save(b); sys.stdout.buffer.write(b.getvalue())"]);
  assert.equal(generated.status, 0, generated.stderr.toString());
  const result = await renderReferencePages(python, generated.stdout, [1]);
  assert.equal(result[0].page, 1);
  assert.equal(Buffer.from(result[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
  await assert.rejects(renderReferencePages(python, generated.stdout, [2]), /outside the document/);
  await assert.rejects(renderReferencePages(python, generated.stdout, [1, 2, 3, 4]), /limits/);
});

test('an authorized plan chat captures the selected PDF page before exporting', async () => {
  const { spawnSync } = await import('node:child_process');
  const { chatPlansHandler } = await import('../main/research/chat-plans.ts');
  const python = new URL('../.delphi-build/python/bin/python3', import.meta.url).pathname;
  const pdf=spawnSync(python,['-c',"import pypdfium2 as p,sys,io; d=p.PdfDocument.new(); d.new_page(120,100); b=io.BytesIO(); d.save(b); sys.stdout.buffer.write(b.getvalue())"]);
  assert.equal(pdf.status,0);
  const dir=mkdtempSync('/tmp/delphi-reference-chat-');const store=new PlanStore(dir);const plans=new LocalPlans(store,join(dir,'plans'));
  const proposal={...proposalPlan,reference:[{...draft.reference[0],pages:[1],passages:[{location:'Figure 2',excerpt:'An unmatched mathematical transcription.'}]}],setup:['source','proposed','user'].map(basis=>({component:'Batch size',setting:'256 examples',basis,...(basis==='source'?{source:{sourceId:'paper1',location:'Section 3'}}:{})}))};
  try {
    const handler=chatPlansHandler({plans,python,origin:'http://localhost:5000',backendUrl:'http://127.0.0.1:8000',authenticate:async()=>true,installation:async()=>'',fetch:async(input,init)=>{
      const url=String(input);
      if(init?.method==='POST'){
        const prompt=JSON.parse(String(init.body)).prompt;
        assert.ok(prompt.includes('basis is exactly source (reported by a document'));
        assert.ok(prompt.includes('Do not include monitoring or deliverables'));
        assert.ok(prompt.includes('Each reference.pages array allows at most 3 page numbers'));
        assert.ok(prompt.includes('most plans need none'));
        const marker=prompt.match(/```delphi-plan-[a-f0-9]+\n/)[0];
        return new Response(`data: ${JSON.stringify({type:'delta',text:marker+JSON.stringify({action:'create_plan',plan:proposal})+'\n```'})}\n\ndata: {"type":"done"}\n\n`,{headers:{'content-type':'text/event-stream'}});
      }
      if(url.endsWith('/text'))return new Response('Temporal context distinguishes flashes from cuts.');
      if(url.endsWith('/file'))return new Response(new Uint8Array(pdf.stdout),{headers:{'content-type':'application/pdf'}});
      if(url.endsWith('/api/projects/p1'))return Response.json({papers:[{id:'paper1',title:'Source document'}]});
      return Response.json({messages:[]});
    }});
    const response=await handler(new Request('http://localhost:5000/api/chat/stream',{method:'POST',headers:{origin:'http://localhost:5000','content-type':'application/json'},body:JSON.stringify(withConversation({prompt:'Reproduce Figure 2',desktop_mode:'plan',scope:'document',project_id:'p1',paper_id:'paper1'}))}));
    const streamed = await response!.text();
    assert.ok(streamed.includes('Saved locally'));
    assert.ok(streamed.indexOf('Checking sources and saving plan') < streamed.indexOf('Saved locally'));
    assert.ok(streamed.indexOf('Saved locally') < streamed.indexOf('\"type\":\"done\"'));
    assert.ok(!streamed.includes('delphi-plan-'));
    const plan=plans.list()[0];assert.equal((plan.context.referenceImages as any[])[0].page,1);
    assert.ok(plans.html(plan).includes('data:image/png;base64,'));
    assert.ok(!JSON.stringify(plan.plan).includes('unmatched mathematical'));
    assert.equal((plan.plan as any).reference[0].passages.length,0);
    assert.equal((plan.context.documents as any[])[0].text,'Temporal context distinguishes flashes from cuts.');
    assert.deepEqual((plan.plan as any).setup.map((d: {basis: string})=>d.basis),['source','proposed','user']);
    proposal.setup[1].basis='unverified guess';
    const rejected=await handler(new Request('http://localhost:5000/api/chat/stream',{method:'POST',headers:{origin:'http://localhost:5000','content-type':'application/json'},body:JSON.stringify(withConversation({prompt:'Save another plan',desktop_mode:'plan',scope:'document',project_id:'p1',paper_id:'paper1'}))}));
    const errorText=await rejected!.text();
    assert.ok(errorText.includes('No plan was saved'));
    assert.ok(!errorText.includes('invalid_value'));
    assert.ok(!errorText.includes('invalid_union'));
    assert.equal(plans.list().length,1);

  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

for (const placement of ['reference', 'setup', 'prose', 'foreign'] as const) {
  test(`plan capture follows structured sources in the current project: ${placement}`, async () => {
    const { chatPlansHandler } = await import('../main/research/chat-plans.ts');
    const dir = mkdtempSync('/tmp/delphi-plan-sources-');
    const store = new PlanStore(dir), plans = new LocalPlans(store, join(dir, 'plans'));
    const sourceId = placement === 'foreign' ? 'other-project-paper' : 'paper2';
    const proposal = {
      ...proposalPlan, method: 'Compare paper1 with paper2.',
      reference: [{ ...draft.reference[0], pages: [], passages: [],
        sourceId: placement === 'reference' || placement === 'foreign' ? sourceId : 'paper1' }],
      setup: [{ component: 'Threshold', setting: '0.5', basis: 'source', source: { sourceId: placement === 'setup' ? sourceId : 'paper1', location: 'Section 3' } }],
    };
    const reads: string[] = [];
    try {
      const handler = chatPlansHandler({ plans, origin: 'http://localhost:5000', backendUrl: 'http://127.0.0.1:8000',
        authenticate: async () => true, installation: async () => '', fetch: async (input, init) => {
          const url = new URL(String(input));
          if (init?.method === 'POST') {
            const prompt = JSON.parse(String(init.body)).prompt;
            const marker = prompt.match(/```delphi-plan-[a-f0-9]+\n/)[0];
            return new Response(`data: ${JSON.stringify({ type: 'delta', text: marker + JSON.stringify({ action: 'create_plan', plan: proposal }) + '\n```' })}\n\ndata: {"type":"done"}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
          }
          if (url.pathname === '/api/projects/p1') return Response.json({ papers:
            ['paper1', 'paper2', 'paper3'].map(id => ({ id, title: id })) });
          if (url.pathname.endsWith('/text')) {
            reads.push(url.pathname);
            return new Response('Temporal context distinguishes flashes from cuts.');
          }
          return Response.json({ messages: [] });
        },
      });
      const response = await handler(new Request('http://localhost:5000/api/chat/stream', {
        method: 'POST', headers: { origin: 'http://localhost:5000', 'content-type': 'application/json' },
        body: JSON.stringify(withConversation({ prompt: 'Plan the comparison', desktop_mode: 'plan',
          scope: 'document', project_id: 'p1', paper_id: 'paper1', referenced_paper_ids: ['paper3'] })),
      }));
      const streamed = await response!.text();
      const expected = ['paper1', 'paper3', ...(['reference', 'setup'].includes(placement) ? ['paper2'] : [])];
      assert.deepEqual(reads, expected.map(id => `/api/projects/p1/papers/${id}/text`));
      if (placement === 'foreign') {
        assert.equal(plans.list().length, 0);
        assert.ok(streamed.includes('Reference document was not captured'));
        assert.ok(!streamed.includes('Saved locally'));
      } else {
        assert.ok(streamed.includes('Saved locally'));
        const documents = plans.list()[0].context.documents as { id: string; text: string }[];
        assert.deepEqual(documents.map(document => document.id), expected);
        assert.ok(documents.every(document => document.text.includes('Temporal context')));
      }
    } finally { plans.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

 test('decision attribution accepts known equivalents but never guesses unknown provenance', () => {
  for (const basis of ['invented', '', null, 42]) {
    const result = scientificV3.safeParse({...draft, decisions:[{...draft.decisions[0],basis}]});
    assert.equal(result.success,false);
  }
 });

test('excess reference pages fail precisely and a three-page selection preserves the wider target', () => {
  const target = 'Core architecture and supporting figures on pages 2, 4, 5, 6, 8, 16, 18, and 21';
  const reference = { ...draft.reference[0], target, pages: [2, 4, 5, 6, 8, 16, 18, 21] };
  const rejected = scientificV3.safeParse({ ...draft, reference: [reference] });
  assert.equal(rejected.success, false);
  if (!rejected.success) assert.deepEqual(rejected.error.issues.map(issue => ({path: issue.path, code: issue.code})), [
    { path: ['reference', 0, 'pages'], code: 'too_big' },
  ]);
  const accepted = scientificV3.parse({ ...draft, reference: [{ ...reference, pages: [2, 6, 8] }] });
  assert.equal(accepted.reference[0].target, target);
  assert.deepEqual(accepted.reference[0].pages, [2, 6, 8]);
});
