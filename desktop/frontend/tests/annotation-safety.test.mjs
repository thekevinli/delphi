import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../app/components/PdfViewer.tsx',import.meta.url),'utf8');

test('overlapping PDF highlights never delete existing records or notes',async()=>{
  const code=source.slice(source.indexOf('  const unionHighlight = async ('),source.indexOf('  const saveSelection ='))
    .replace(/page: number,/,'page,').replace(/rects: PdfRect\[\],/,'rects,').replace(/text: string,/,'text,').replace(/\): Promise<Highlight \| null> =>/,') =>');
  const old=[{id:'a',type:'pdf',page:1,text:'first',rects:[{x:0,y:0,w:.2,h:.1}]},{id:'b',type:'pdf',page:1,text:'second',rects:[{x:.1,y:0,w:.2,h:.1}]}];
  const removed=[];const moved=[];let created;
  const run=new Function('highlights','pageAspect','mergeIntoLineBands','sameBands','paintedRects','onHighlight','onRemoveHighlight','onSaveNote','setAnnotationError',code+';return unionHighlight;')(
    old,()=>1,r=>r,(a,b)=>JSON.stringify(a)===JSON.stringify(b),r=>r,
    async h=>created={id:'c',...h},id=>removed.push(id),n=>moved.push(n),()=>{});
  const rects=[{x:0,y:0,w:.3,h:.1}];
  assert.equal((await run(1,rects,'both')).id,'c');
  assert.deepEqual(removed,[]);assert.deepEqual(moved,[]);
  assert.deepEqual(created.rects,rects);assert.equal(created.text,'both');
  assert.equal((await run(1,old[0].rects,'first')).id,'a');
});

test('failed note saves retain the mounted draft, and successful saves do not close newer edits',async()=>{
  const begin=source.indexOf('      const open = openNoteRef.current;',source.indexOf('  const closeNote ='));
  const code=source.slice(begin,source.indexOf('\n    },\n    [onRemoveHighlight',begin));
  const open={highlightId:'a',page:1,anchorY:.2,quotedText:'q',body:'my draft'};
  const ref={current:open},saving={current:false},closed=[],errors=[];
  const make=save=>new Function('openNoteRef','savingNote','setAnnotationError','onSaveNote','onRemoveHighlight','setOpenNote','return async(save)=>{'+code+'};')(ref,saving,e=>errors.push(e),save,()=>assert.fail('must not delete'),v=>closed.push(v));
  await make(async()=>{throw Error('offline');})(true);
  assert.equal(ref.current,open);assert.deepEqual(closed,[]);assert.equal(errors.at(-1),'offline');
  await make(async()=>{open.body='newer edit';})(true);
  assert.equal(ref.current,open);assert.deepEqual(closed,[]);
  assert.equal(open.persisted,true);
  await make(async()=>{})(false);
  assert.equal(ref.current,null);assert.deepEqual(closed,[null]);
});

test('a webpage note card saves what was written and takes back a mark nothing was written on',async()=>{
  const page=readFileSync(new URL('../app/components/PageNotes.tsx',import.meta.url),'utf8');
  const begin=page.indexOf('      const open = previous ?? cardRef.current;');
  const code=page.slice(begin,page.indexOf('\n    },\n    [drafts, highlights, onCard, onError, onRemoveHighlight, onSaveNote],',begin));
  assert.ok(begin>0&&code.length>200,'the card close logic is where this test reads it');
  // `drafts` is the shared map the card, the list and the PDF card type into.
  const build=(card,notes,saveNote,removeHighlight)=>{
    const drafts=new Map(card?.body!==undefined?[[card.highlightId,card.body]]:[]);
    const state={card:{current:card},busy:{current:false},drafts,queued:{current:false},closeRef:{current:null},previousCard:{current:{card,clicks:0}},closed:[],errors:[],saved:[],removed:[]};
    state.close=new Function('cardRef','busy','notesRef','drafts','onSaveNote','highlights','onRemoveHighlight','onCard','onError','queuedSave','closeRef','previousCard','return async(save,previous)=>{'+code+'};')(
      state.card,state.busy,{current:notes},drafts,
      saveNote??(async note=>{state.saved.push(note);}),[{id:'h1',text:'the marked passage'}],
      removeHighlight??(async id=>{state.removed.push(id);}),value=>{state.closed.push(value);state.card.current=value;},message=>{if(message)state.errors.push(message);},
      state.queued,state.closeRef,state.previousCard);
    state.closeRef.current=state.close;
    return state;
  };
  // Pressing Note and then clicking away without writing anything takes the
  // mark with it: the reader never asked for a highlight, only for a card.
  const abandoned=build({highlightId:'h1',mode:'editor',ours:true,body:''},[]);
  await abandoned.close(true);
  assert.deepEqual(abandoned.removed,['h1']);assert.deepEqual(abandoned.saved,[]);assert.deepEqual(abandoned.closed,[null]);
  // A mark that was already there keeps its place when a card opened over it
  // is dismissed empty.
  const kept=build({highlightId:'h1',mode:'editor',ours:false,body:''},[]);
  await kept.close(true);
  assert.deepEqual(kept.removed,[]);assert.deepEqual(kept.closed,[null]);
  // Clicking away is a save, and the quote stored with the note is the mark's.
  const written=build({highlightId:'h1',mode:'editor',ours:true,body:'  a thought  '},[]);
  await written.close(true);
  assert.deepEqual(written.saved,[{highlightId:'h1',page:null,anchorY:null,quotedText:'the marked passage',body:'a thought'}]);
  assert.deepEqual(written.removed,[]);assert.deepEqual(written.closed,[null]);
  assert.equal(written.drafts.has('h1'),false,'a saved draft is spent');
  // Emptying a note that exists deletes it, exactly as the PDF card does.
  const emptied=build({highlightId:'h1',mode:'editor',ours:false,body:''},[{highlightId:'h1',body:'was here'}]);
  await emptied.close(true);
  assert.deepEqual(emptied.removed,['h1']);
  // Escape cancels an edit, including an empty draft. A card can still be
  // marked ours after its first save, so the persisted note wins over that flag.
  for (const ours of [false, true]) {
    for (const body of ['', '   ', 'an edit to discard']) {
      const cancelled=build({highlightId:'h1',mode:'editor',ours,body},[{highlightId:'h1',body:'was here'}]);
      await cancelled.close(false);
      assert.deepEqual(cancelled.removed,[]);
      assert.deepEqual(cancelled.saved,[]);
      assert.deepEqual(cancelled.closed,[null]);
      assert.equal(cancelled.drafts.has('h1'),false,'a cancelled edit is discarded');
    }
  }
  // Cancelling a new note takes back the temporary mark, written on or not:
  // Escape creates nothing.
  for (const body of ['', 'second thoughts']) {
    const cancelledNew=build({highlightId:'h1',mode:'editor',ours:true,body},[]);
    await cancelledNew.close(false);
    assert.deepEqual(cancelledNew.removed,['h1']);
    assert.deepEqual(cancelledNew.saved,[]);
    assert.deepEqual(cancelledNew.closed,[null]);
  }
  // A save that fails keeps the card open with the draft in it.
  const offline=build({highlightId:'h1',mode:'editor',ours:true,body:'unsent'},[],async()=>{throw Error('offline');});
  await offline.close(true);
  assert.equal(offline.card.current.highlightId,'h1');assert.deepEqual(offline.closed,[]);assert.equal(offline.errors.at(-1),'offline');
  assert.equal(offline.drafts.get('h1'),'unsent','the draft outlives a failed save');
  // Text typed while a save is in flight is newer than what was saved, so the
  // card stays open with it — and an Enter pressed meanwhile saves it after.
  let release;
  const racing=build({highlightId:'h1',mode:'editor',ours:true,body:'first'},[],async note=>{
    racing.saved.push(note);
    if(racing.saved.length===1) await new Promise(resolve=>{release=resolve;});
  });
  const pending=racing.close(true);
  racing.drafts.set('h1','newer');
  await racing.close(true);
  assert.deepEqual(racing.saved.map(note=>note.body),['first']);
  release();await pending;await new Promise(resolve=>setTimeout(resolve));
  assert.deepEqual(racing.saved.map(note=>note.body),['first','newer']);
  assert.deepEqual(racing.closed,[null]);
  // Without that second Enter the card simply stays open on the newer text.
  const typing=build({highlightId:'h1',mode:'editor',ours:true,body:'first'},[],async note=>{typing.saved.push(note);typing.drafts.set('h1','still typing');});
  await typing.close(true);
  assert.deepEqual(typing.closed,[]);assert.equal(typing.card.current.highlightId,'h1');
  // Moving to another mark saves the card being left, not the one arriving.
  const leaving=build({highlightId:'h1',mode:'editor',ours:true,body:'left behind'},[]);
  const arriving={highlightId:'h2',mode:'menu',ours:false};
  const previous=leaving.card.current;leaving.card.current=arriving;
  await leaving.close(true,previous);
  assert.deepEqual(leaving.saved.map(note=>[note.highlightId,note.body]),[['h1','left behind']]);
  assert.equal(leaving.card.current,arriving,'the arriving card stays open');
  // Reading a note is not writing one: closing a preview saves and deletes nothing.
  const reading=build({highlightId:'h1',mode:'preview',ours:false},[{highlightId:'h1',body:'was here'}]);
  await reading.close(true);
  assert.deepEqual(reading.saved,[]);assert.deepEqual(reading.removed,[]);assert.deepEqual(reading.closed,[null]);
});

test('working with notes is not reading on: the library stays where it is', async () => {
  const workspace = readFileSync(new URL('../app/components/Workspace.tsx', import.meta.url), 'utf8');
  const begin = workspace.indexOf('  const collapseForReading = (event');
  const code = workspace.slice(begin, workspace.indexOf('\n  };', begin));
  const selector = code.match(/closest\(\s*"([^"]+)"/)[1];
  // Clicking an entry in Highlights & Notes to be taken to its passage folded
  // the library, which rescaled the PDF under the scroll and missed the mark.
  for (const part of ["[role='button']", '.annotations-panel', '.note-card', '.selection-menu', 'button', 'a'])
    assert.ok(selector.split(',').map(s => s.trim()).includes(part), `a click on ${part} is not a reading click`);
});
