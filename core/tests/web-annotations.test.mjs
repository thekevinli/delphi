import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const context=vm.createContext({crypto:webcrypto,TextEncoder,performance});
vm.runInContext(await readFile(new URL('../delphi_core/web_annotations.js',import.meta.url),'utf8'),context);
const engine=context.DelphiAnnotations;
const note=(idx,start,end)=>({anchor:engine.anchor(idx,start,end),text:idx.text.slice(start,end)});

test('same fingerprint verifies saved offsets without relocation',async()=>{
  const idx=await engine.index(['A 😀 passage','the end']);
  const h=note(idx,2,12);
  assert.equal(engine.resolve(idx,h,false,0).status,'placed');
  assert.equal(h.text,'😀 passage');
});
test('unchanged unique blocks survive prepended paragraphs',async()=>{
  const before=await engine.index(['First','kept passage','Last']);
  const after=await engine.index(['An update','First','kept passage','Last']);
  const result=engine.resolve(after,note(before,6,18),true,0);
  assert.equal(result.status,'placed');assert.equal(after.text.slice(result.start,result.end),'kept passage');
});
test('unique exact quote survives edited context',async()=>{
  const before=await engine.index(['Before. Unique quote. Old conclusion.']);
  const after=await engine.index(['New introduction. Unique quote. Different conclusion.']);
  assert.equal(engine.resolve(after,note(before,8,21),true).status,'placed');
});
test('duplicate exact occurrences use context and tied matches remain ambiguous',async()=>{
  const before=await engine.index(['red QUOTE blue']);
  const h=note(before,4,9);
  const unique=await engine.index(['red QUOTE blue. red QUOTE green']);
  assert.equal(engine.resolve(unique,h,true).start,4);
  const tied=await engine.index(['red QUOTE blue. red QUOTE blue']);
  assert.equal(engine.resolve(tied,h,true).status,'ambiguous');
});
test('unfinished acquisition and exhausted search are unknown, not missing',async()=>{
  const before=await engine.index(['original passage']);
  const missing=await engine.index(['something different']);
  const h=note(before,0,16);
  assert.equal(engine.resolve(missing,h,false).status,'unknown');
  assert.equal(engine.resolve(missing,h,true,0).status,'unknown');
  assert.equal(engine.resolve(missing,h,true).status,'missing');
});
test('a wall at either edge of the page is recognised; a short or changed article is not one',async()=>{
  assert.equal(engine.walled(await engine.index(['404 not found'])),true);
  assert.equal(engine.walled(await engine.index(['one','two','three','Subscribe to continue'])),true);
  assert.equal(engine.walled(await engine.index(['one paragraph'])),false);
  assert.equal(engine.walled(await engine.index(['new','one paragraph','two paragraph'])),false);
});
test('no case folding or fuzzy relocation',async()=>{
  const before=await engine.index(['Results']);const after=await engine.index(['RESULTS']);
  assert.equal(engine.resolve(after,note(before,0,7),true).status,'missing');
});

test('the worker keeps selection-time evidence across a changed or unavailable page',async()=>{
  const messages=[];
  const scope=vm.createContext({crypto:webcrypto,TextEncoder,performance,setTimeout,postMessage:m=>messages.push(m)});
  vm.runInContext(await readFile(new URL('../delphi_core/web_annotations.js',import.meta.url),'utf8'),scope);
  vm.runInContext(await readFile(new URL('../delphi_core/web_annotation_worker.js',import.meta.url),'utf8'),scope);
  await scope.onmessage({data:{type:'index',generation:0,epoch:1,texts:['original article']}});
  const original=messages.at(-1).revision;
  // The frame's index has since moved on; the capture carries its own reading.
  await scope.onmessage({data:{type:'index',generation:1,epoch:1,texts:['a page that kept changing']}});
  await scope.onmessage({data:{type:'capture',texts:['original article'],start:0,end:8,pin:true,request:'reply'}});
  assert.equal(messages.at(-1).type,'captured');
  assert.equal(messages.at(-1).text,'original');
  assert.equal(messages.at(-1).anchor.revision,original);
  await scope.onmessage({data:{type:'invalidate'}});
  await scope.onmessage({data:{type:'index',generation:0,epoch:2,texts:['404 not found']}});
  await scope.onmessage({data:{type:'evidence',quote:'original',request:'ask'}});
  assert.equal(messages.at(-1).texts[0],'original article');
  assert.equal(messages.at(-1).revision,original);
  messages.length=0;
  const stale=scope.onmessage({data:{type:'index',generation:0,epoch:3,texts:['racing index']}});
  await scope.onmessage({data:{type:'invalidate'}});
  await stale;
  assert.equal(messages.length,0);
});

test('the worker ignores an older panel\'s baseline and holds placements back while a wall is on screen',async()=>{
  const messages=[];
  const scope=vm.createContext({crypto:webcrypto,TextEncoder,performance,setTimeout,postMessage:m=>messages.push(m)});
  vm.runInContext(await readFile(new URL('../delphi_core/web_annotations.js',import.meta.url),'utf8'),scope);
  vm.runInContext(await readFile(new URL('../delphi_core/web_annotation_worker.js',import.meta.url),'utf8'),scope);
  const article=await engine.index(['An article with a passage in it.']);
  const mark={id:'h1',...note(article,17,24)};
  // What a panel from before this worker still sends first.
  await scope.onmessage({data:{type:'baseline',epoch:1,texts:['An article with a passage in it.']}});
  assert.equal(messages.length,0);
  const placements=async(texts,generation)=>{
    await scope.onmessage({data:{type:'index',generation,epoch:1,texts}});
    const {revision}=messages.at(-1);
    assert.equal('degraded' in messages.at(-1),false);
    await scope.onmessage({data:{type:'resolve',generation,epoch:1,revision,complete:true,annotations:[mark]}});
    return messages.at(-1).results[0].status;
  };
  assert.equal(await placements(['An article with a passage in it.'],0),'placed');
  assert.equal(await placements(['A different article.'],1),'missing');
  // A wall is not an answer about the article, so nothing is final.
  assert.equal(await placements(['Subscribe to continue reading'],2),'unknown');
});

test('context slices preserve whole Unicode characters at their boundaries',async()=>{
  const idx=await engine.index(['😀'+'x'.repeat(127)+'q'+'x'.repeat(127)+'😀']);
  const a=engine.anchor(idx,129,130);
  assert.ok(a.prefix.isWellFormed());assert.ok(a.suffix.isWellFormed());
});

test('reopening an already-resolved revision skips search without changing the original anchor',async()=>{
  const before=await engine.index(['An old introduction. A unique quote. Old ending.']);
  const h=note(before,21,35);
  const current=await engine.index(['Changed intro. A unique quote. New ending.']);
  const placed=engine.resolve(current,h,true);
  assert.equal(placed.status,'placed');
  const cached={...h,placement:{revision:current.revision,start:placed.start,end:placed.end}};
  assert.equal(engine.resolve(current,cached,false,0).status,'placed');
  assert.equal(cached.anchor.revision,before.revision);
  cached.placement.start++;
  assert.equal(engine.resolve(current,cached,true,0).status,'unknown');
});
