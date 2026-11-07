import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationBox, annotationCapture, annotationIndex, annotationSelection, mergeAnnotationRead, pageCopy } from '../app/lib/web-annotation-state.ts';

test('the frame boundary refuses malformed ranges, nonfinite geometry and oversized indexes', () => {
  assert.equal(annotationBox({x:NaN,y:0,w:10,h:10}), null);
  assert.equal(annotationBox({x:0,y:0,w:-1,h:1}), null);
  assert.deepEqual(annotationBox({x:-10,y:5,w:20,h:10}), {x:-10,y:5,w:20,h:10});
  for (const value of [null, {selection:-1}, {selection:0.5}, {selection:'3'}]) assert.equal(annotationSelection(value), undefined);
  assert.deepEqual(annotationSelection({selection:2,start:0}), {selection:2});
  for (const value of [{request:'r',texts:['abc'],start:-1,end:2}, {request:'r',texts:['abc'],start:0,end:20001}, {request:'r',texts:[{}],start:0,end:1}, {request:'x'.repeat(65),texts:['abc'],start:0,end:1}, {request:'r',texts:['x'.repeat(600000)],start:0,end:1}])
    assert.equal(annotationCapture(value), null);
  assert.deepEqual(annotationCapture({request:'r',texts:['abc'],start:0,end:2,extra:1}), {request:'r',texts:['abc'],start:0,end:2});
  assert.deepEqual(annotationCapture({request:'r',error:'Select it again.'}), {request:'r',error:'Select it again.'});
  assert.equal(annotationIndex({generation:0,texts:['x'.repeat(600000)]}), null);
  assert.equal(annotationIndex({generation:0,texts:[{}]}), null);
  assert.deepEqual(annotationIndex({generation:0,texts:['😀'],complete:'true'}), {generation:0,texts:['😀'],complete:false});
});

test('late reads preserve edits and cannot resurrect deleted annotations', () => {
  const current=[{id:'a',body:'new body'},{id:'c',body:'created while loading'}];
  const loaded=[{id:'a',body:'old body'},{id:'b',body:'deleted while loading'},{id:'d',body:'stored'}];
  assert.deepEqual(mergeAnnotationRead(current,loaded,item=>item.id,new Set(['b'])), [...current,loaded[2]]);
  const notes=[{id:'new-note-id',highlightId:'h',body:'edited'}];
  assert.deepEqual(mergeAnnotationRead(notes,[{id:'old-note-id',highlightId:'h',body:'old'}],item=>item.highlightId,new Set()),notes);
});

test('a page copy from the frame is held to the limits the backend enforces', () => {
  const copy = {html:'<html><body>An article</body></html>',width:1180,url:'https://example.org/a'};
  assert.deepEqual(pageCopy({...copy,request:'r',extra:1},1000), copy);
  for (const value of [{...copy,html:''},{...copy,html:{}},{...copy,width:319},{...copy,width:10001},{...copy,width:1180.5},{...copy,width:'1180'},
    {...copy,url:'javascript:alert(1)'},{...copy,url:'not a url'},{...copy,url:'https://example.org/'+'a'.repeat(2048)},{error:'Too large'}])
    assert.equal(pageCopy(value,1000), null);
  // The limit is UTF-8 bytes, which is what the backend counts.
  const emoji = {...copy,html:'😀'.repeat(300)};
  assert.equal(emoji.html.length <= 1000 && new TextEncoder().encode(emoji.html).length > 1000, true);
  assert.equal(pageCopy(emoji,1000), null);
});
