const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const bridge=fs.readFileSync(require('node:path').join(__dirname,'../delphi_core/web_annotation_bridge.js'),'utf8');
// What the reader's parent does to make an annotation: ask the frame to capture
// the selection, and read the page text and offsets it answers with.
const measure=`window.measure=r=>{const s=annotations.selection(r);if(!s)return null;annotations.command({type:'annotation-capture',request:'m'+s.selection,selection:s.selection});const m=messages.filter(x=>x.type==='annotation-capture').at(-1);return m.error?null:{start:m.start,end:m.end,quote:m.texts.join('\\n').slice(m.start,m.end)};};`;
const fixture=`<!doctype html><html><head><style>.mobile{display:none}h1{text-transform:uppercase}</style></head><body><article><h1>Results</h1><p id="passage">An exact <b>important</b> passage.</p><p class="mobile">Duplicate mobile content</p><div role="dialog">Sign in popup</div><p id="later">Later content.</p><div><video></video><button>Play</button><span id="clock">0:00</span></div></article></body></html>`;
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(fixture));
 await win.webContents.executeJavaScript(`window.messages=[];${bridge};${measure};window.annotations=installAnnotations(m=>messages.push(m));const initialRange=document.createRange();initialRange.selectNodeContents(document.getElementById('passage'));getSelection().addRange(initialRange);window.ticker=setInterval(()=>{document.getElementById('clock').textContent=String(Date.now())},100);void 0;`);
 // The clock ticks all along: the page is indexed within the capped wait anyway.
 await new Promise(r=>setTimeout(r,2400));
 const result=await win.webContents.executeJavaScript(`(async()=>{
  const initial=messages.find(m=>m.type==='annotation-index');
  clearInterval(ticker);
  await new Promise(r=>setTimeout(r,1200));
  if(!initial)throw Error(JSON.stringify(messages));
  const text=initial.texts.join('\\n');
  const p=document.getElementById('passage');const r=document.createRange();r.selectNodeContents(p);
  const selected=measure(r);
  const before=p.innerHTML;
  annotations.command({type:'annotation-paint',generation:messages.filter(m=>m.type==='annotation-index').at(-1).generation,ranges:[{handle:'temporary',start:selected.start,end:selected.end}]});
  const paintCount=CSS.highlights.get('delphi-annotations')?.size;
  const after=p.innerHTML;
  const indexes=messages.filter(m=>m.type==='annotation-index').length;
  document.querySelector('.mobile').style.display='block';
  await new Promise(r=>setTimeout(r,1200));
  const layoutInvalidated=messages.filter(m=>m.type==='annotation-index').length!==indexes;
  p.replaceChildren(document.createTextNode('Updated article text.'));
  await new Promise(r=>setTimeout(r,1300));
  const last=messages.filter(m=>m.type==='annotation-index').at(-1);
  return {text,quote:selected.quote,before,after,paintCount,layoutInvalidated,last:last?.texts,highlightKept:CSS.highlights.has('delphi-annotations')};
 })()`);
 assert.equal(result.quote,'An exact important passage.');assert.equal(result.before,result.after);assert.equal(result.paintCount,1);
 assert.equal(result.layoutInvalidated,false);assert.ok(result.text.includes('Results'));assert.ok(result.text.includes('Duplicate mobile content'));assert.ok(!result.text.includes('Sign in popup'));assert.ok(result.text.includes('Later content.'));
 assert.ok(result.highlightKept,'a change to the page must not blank the highlights until they are repainted');assert.ok(result.last.includes('Updated article text.'));
 // A mark is a control: the pointer says so before it is clicked, a click on it
 // reports where it is painted so a note card can hang off that line, and the
 // empty margin to the right of a short highlighted line is neither — a caret
 // lookup there answers with the line's last offset, which is inside the range,
 // and that is what used to open somebody's note from the white space.
 const painted=await win.webContents.executeJavaScript(`(async()=>{
  const idx=messages.filter(m=>m.type==='annotation-index').at(-1);
  const p=document.getElementById('passage');p.style.width='320px';
  const r=document.createRange();r.selectNodeContents(p);
  const selected=measure(r);
  messages.length=0;
  await annotations.command({type:'annotation-paint',generation:idx.generation,ranges:[{handle:'noted',start:selected.start,end:selected.end,measure:true}]});
  const mark=CSS.highlights.get('delphi-annotations').values().next().value.getClientRects()[0];
  const block=p.getBoundingClientRect();
  return {mark:{x:mark.x,y:mark.y,w:mark.width,h:mark.height},marginX:block.right-4};
 })()`);
 const at=(x,y)=>({x:Math.round(x),y:Math.round(y)});
 const middle=at(painted.mark.x+painted.mark.w/2,painted.mark.y+painted.mark.h/2);
 const margin=at(painted.marginX,painted.mark.y+painted.mark.h/2);
 const hovering=async point=>{
  win.webContents.sendInputEvent({type:'mouseMove',...point});
  await new Promise(r=>setTimeout(r,150));
  return win.webContents.executeJavaScript(`document.documentElement.hasAttribute('data-delphi-annotation-hover')`);
 };
 const clickAt=async point=>{
  win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
  await new Promise(r=>setTimeout(r,150));
  return win.webContents.executeJavaScript(`messages.filter(m=>m.type==='annotation-click')`);
 };
 // As in a hidden or occluded window, where no animation frame ever arrives:
 // the hover state must still follow the pointer off a mark, not stick on.
 await win.webContents.executeJavaScript('window.requestAnimationFrame=()=>1;0');
 assert.equal(await hovering(middle),true,'the pointer must show that a mark is clickable');
 assert.equal(await hovering(margin),false,'the margin past a line is not the mark');
 assert.deepEqual(await clickAt(margin),[],'a click in the margin opens nothing');
 assert.equal(await win.webContents.executeJavaScript(`annotations.isMark(${middle.x},${middle.y})`),true,'a click on a mark is the reader answering it, not reading on');
 assert.equal(await win.webContents.executeJavaScript(`annotations.isMark(${margin.x},${margin.y})`),false);
 const clicks=await clickAt(middle);
 assert.equal(clicks.length,1);assert.deepEqual(clicks[0].handles,['noted']);
 assert.ok(Math.abs(clicks[0].rect.y-painted.mark.y)<2&&clicks[0].rect.w>1,JSON.stringify(clicks[0]));
 // Positions for the margin icons, and only for the marks the parent asked for:
 // measuring a thousand highlights on every scroll is a layout the reader feels.
 const geometry=await win.webContents.executeJavaScript(`messages.filter(m=>m.type==='annotation-geometry').at(-1)`);
 assert.deepEqual(geometry.items.map(item=>item.handle),['noted']);
 assert.ok(Math.abs(geometry.items[0].top-painted.mark.y)<2,JSON.stringify(geometry.items[0]));
 // The middle of the first line, where a menu over the mark is placed.
 assert.ok(Math.abs(geometry.items[0].x-(painted.mark.x+painted.mark.w/2))<2,JSON.stringify(geometry.items[0]));
 const performanceResult=await win.webContents.executeJavaScript(`(async()=>{
   document.body.innerHTML='<article>'+Array.from({length:4000},(_,i)=>'<p>'+String(i).padStart(5,'0')+' '+('a'.repeat(80))+'</p>').join('')+'</article>';
   await new Promise(r=>setTimeout(r,100));
   const tasks=[];const observer=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(e=>e.duration)));
   observer.observe({entryTypes:['longtask']});
   await new Promise(r=>setTimeout(r,2500));
   const idx=messages.filter(m=>m.type==='annotation-index').at(-1);
   const chars=idx.texts.join('\\n').length;
   await annotations.command({type:'annotation-paint',generation:idx.generation,ranges:Array.from({length:1000},(_,i)=>({handle:String(i),start:i*87,end:i*87+5}))});
   await new Promise(r=>setTimeout(r,2000));
   observer.disconnect();
   return {chars,painted:CSS.highlights.get('delphi-annotations')?.size,longTasks:tasks};
 })()`);
 assert.ok(performanceResult.chars>300000);assert.equal(performanceResult.painted,1000);assert.deepEqual(performanceResult.longTasks,[]);
 console.log(JSON.stringify({performance:performanceResult}));
 // An article with a live widget in its body — a simulation relabelling itself
 // and a counter ticking every 150ms, the shape fleetwood.dev's posts have.
 // The page never goes quiet. It is indexed anyway within the capped wait, a
 // selection beside the widget is captured from the page as it is, and an
 // edited paragraph reaches the index however busy the rest of the page is.
 const widgetPage=`<!doctype html><html><body><article><p id="before">Prose before the widget.</p><div id="sim"><div class="grid"><div class="cell"><span id="count">0</span></div><div class="label" id="state">(Busy)</div></div></div><p id="after">Prose after the widget.</p></article></body></html>`;
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(widgetPage));
 const live=await win.webContents.executeJavaScript(`(async()=>{
  window.messages=[];${bridge};${measure};window.annotations=installAnnotations(m=>messages.push(m));
  let n=0;const tick=setInterval(()=>{n++;document.getElementById('count').textContent=String(n);document.getElementById('state').textContent=n%2?'(Stalled)':'(Busy)';},150);
  await new Promise(r=>setTimeout(r,2500));
  const indexed=messages.filter(m=>m.type==='annotation-index').at(-1);
  const r=document.createRange();r.selectNodeContents(document.getElementById('after'));
  const selection=measure(r);
  document.getElementById('before').textContent='Edited prose before the widget.';
  await new Promise(r=>setTimeout(r,2300));
  const edited=messages.filter(m=>m.type==='annotation-index').at(-1).texts.join('|').includes('Edited prose before the widget.');
  clearInterval(tick);
  return {text:indexed?indexed.texts.join('|'):null,selection,edited};
 })()`);
 assert.ok(live.text,'an animating widget must not keep the page from ever being indexed');
 assert.ok(live.text.includes('Prose before the widget.')&&live.text.includes('Prose after the widget.'),live.text);
 assert.equal(live.selection?.quote,'Prose after the widget.','a selection beside a live widget can be annotated');
 assert.ok(live.edited,'an edited paragraph reaches the index within the capped wait, however busy the page is');
 // A change elsewhere on the page leaves a painted mark where it is until the
 // repaint replaces it — no blank page in between.
 const steady=await win.webContents.executeJavaScript(`(async()=>{
  await new Promise(r=>setTimeout(r,1500));
  const idx=messages.filter(m=>m.type==='annotation-index').at(-1);
  const r=document.createRange();r.selectNodeContents(document.getElementById('after'));
  const at=measure(r);
  await annotations.command({type:'annotation-paint',generation:idx.generation,ranges:[{handle:'kept',start:at.start,end:at.end}]});
  document.getElementById('before').textContent='Prose before the widget, edited again.';
  await new Promise(r=>setTimeout(r,50));
  const during=CSS.highlights.get('delphi-annotations');
  const painted=during?[...during].map(range=>range.toString()):[];
  await new Promise(r=>setTimeout(r,1300));
  return {reindexed:messages.filter(m=>m.type==='annotation-index').at(-1).generation>idx.generation,painted};
 })()`);
 assert.ok(steady.reindexed);assert.deepEqual(steady.painted,['Prose after the widget.']);
 // Content that arrives is the article growing, not a widget: three posts
 // appended to a feed inside a second are all indexed.
 const grown=await win.webContents.executeJavaScript(`(async()=>{
  const feed=document.createElement('section');feed.id='feed';document.querySelector('article').append(feed);
  for(let i=1;i<=3;i++){const p=document.createElement('p');p.textContent='Feed post number '+i+'.';feed.append(p);await new Promise(r=>setTimeout(r,300));}
  await new Promise(r=>setTimeout(r,1500));
  return messages.filter(m=>m.type==='annotation-index').at(-1).texts.join('|');
 })()`);
 assert.ok(grown.includes('Feed post number 3.'),grown);
 // The reader switching a tab three times is theirs, not the page animating:
 // the panel stays annotatable.
 await win.webContents.executeJavaScript(`(()=>{
  const tabs=document.createElement('div');tabs.innerHTML='<button id="tab">Next</button><div id="panel"><p>Panel one text.</p></div>';
  document.querySelector('article').append(tabs);let n=1;
  document.getElementById('tab').addEventListener('click',()=>{n++;document.getElementById('panel').innerHTML='<p>Panel '+n+' text.</p>';});
 })()`);
 await new Promise(r=>setTimeout(r,1500));
 const tab=await win.webContents.executeJavaScript(`(()=>{const b=document.getElementById('tab').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()`);
 for(let i=0;i<3;i++){win.webContents.sendInputEvent({type:'mouseDown',...tab,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...tab,button:'left',clickCount:1});await new Promise(r=>setTimeout(r,400));}
 await new Promise(r=>setTimeout(r,1600));
 const tabbed=await win.webContents.executeJavaScript(`messages.filter(m=>m.type==='annotation-index').at(-1).texts.join('|')`);
 assert.ok(tabbed.includes('Panel 4 text.'),tabbed);
 // MathJax 2 typesetting a long post, as on sander.ai: one formula at a time,
 // each drawn as a preview and then replaced by its final output, inline
 // formulas in paragraphs and display formulas straight in the content block,
 // with a status box counting up. There it ran for ninety seconds. Nothing
 // about it is special here: the post is indexed while it typesets, prose
 // beside a formula is captured, and every paragraph is still there after.
 const mathPage='<!doctype html><html><body><article><div class="entry-content">'+Array.from({length:40},(_,i)=>'<p id="m'+i+'">Prose sentence '+i+' about <span class="MathJax_Preview"></span><script type="math/tex">x_{'+i+'}</script> and its flow.</p><span class="MathJax_Preview"></span><script type="math/tex; mode=display">y_{'+i+'}</script>').join('')+'<p id="end">Closing prose.</p></div></article></body></html>';
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(mathPage));
 const math=await win.webContents.executeJavaScript(`(async()=>{
  window.messages=[];${bridge};${measure};window.annotations=installAnnotations(m=>messages.push(m));
  const status=document.createElement('div');status.id='MathJax_Message';document.body.append(status);
  const scripts=[...document.querySelectorAll('script[type^="math/"]')];
  let i=0;const typeset=setInterval(()=>{
   const script=scripts[i>>1];if(!script){clearInterval(typeset);status.remove();return;}
   const preview=script.previousElementSibling,display=script.type.includes('display');
   if(i%2===0)preview.innerHTML='<span class="MJXp-math"><span>x</span><span>'+(i>>1)+'</span></span>';
   else{preview.replaceChildren();const out=document.createElement(display?'div':'span');out.className=display?'MathJax_Display':'MathJax_CHTML';out.innerHTML='<span>x</span><span>'+(i>>1)+'</span>';script.before(out);}
   status.textContent='Typesetting math: '+Math.round(50*i/scripts.length)+'%';i++;
  },40);
  const prose=id=>{const r=document.createRange();r.selectNodeContents(document.getElementById(id).firstChild);return measure(r);};
  await new Promise(r=>setTimeout(r,2500));
  const during=messages.filter(m=>m.type==='annotation-index').at(-1);
  const result={indexed:!!during,selection:prose('m3'),typesetting:i<2*scripts.length};
  while(i<2*scripts.length)await new Promise(r=>setTimeout(r,100));
  await new Promise(r=>setTimeout(r,1500));
  return {...result,after:messages.filter(m=>m.type==='annotation-index').at(-1).texts.join('|'),last:prose('m39'),end:prose('end')};
 })()`);
 assert.ok(math.typesetting,'the check must run while MathJax is still typesetting');
 assert.ok(math.indexed,'a page still typesetting its math is indexed');
 assert.equal(math.selection?.quote,'Prose sentence 3 about ','prose beside a formula can be annotated while it typesets');
 assert.ok(math.after.includes('Prose sentence 39 about ')&&math.after.includes('Closing prose.'),math.after.slice(-200));
 assert.equal(math.last?.quote,'Prose sentence 39 about ');assert.equal(math.end?.quote,'Closing prose.');
 // A passage whose own paragraph keeps changing, a relative time ticking in
 // the middle of it: the capture is of the words selected, read with the page
 // as it is at that moment.
 const tickingPage='<!doctype html><html><body><article><p id="t">Updated <span id="ago">0</span> seconds ago, the article says what it says.</p></article></body></html>';
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(tickingPage));
 const ticking=await win.webContents.executeJavaScript(`(async()=>{
  window.messages=[];${bridge};${measure};window.annotations=installAnnotations(m=>messages.push(m));
  let n=0;const tick=setInterval(()=>{document.getElementById('ago').textContent=String(++n);},30);
  await new Promise(r=>setTimeout(r,300));
  const words=document.getElementById('t').lastChild;const r=document.createRange();r.setStart(words,words.data.indexOf('the article'));r.setEnd(words,words.length);
  const captured=measure(r);
  clearInterval(tick);
  return captured;
 })()`);
 assert.equal(ticking?.quote,'the article says what it says.');
 // The annotations list takes the reader to a mark: the page scrolls until the
 // painted passage sits in the middle of the view — found by where it was
 // painted, so a passage with markup inside it is reached like any other.
 const longPage='<!doctype html><html><body><article>'+Array.from({length:200},(_,i)=>i===150?'<p id="target">The <sup>5</sup> passage to <b>reveal</b> here.</p>':'<p>Filler paragraph '+i+' with enough words to take up a line.</p>').join('')+'</article></body></html>';
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(longPage));
 const revealed=await win.webContents.executeJavaScript(`(async()=>{
  window.messages=[];${bridge};${measure};window.annotations=installAnnotations(m=>messages.push(m));
  await new Promise(r=>setTimeout(r,1500));
  const idx=messages.filter(m=>m.type==='annotation-index').at(-1);
  const r=document.createRange();r.selectNodeContents(document.getElementById('target'));
  const at=measure(r);
  await annotations.command({type:'annotation-paint',generation:idx.generation,ranges:[{handle:'far',start:at.start,end:at.end}]});
  const before=window.scrollY;
  await annotations.command({type:'annotation-reveal',generation:idx.generation,start:at.start,end:at.end});
  await new Promise(r=>setTimeout(r,1500));
  const box=r.getBoundingClientRect();
  return {before,after:window.scrollY,middle:box.top+box.height/2,view:innerHeight/2};
 })()`);
 assert.ok(revealed.after>revealed.before,'the page must scroll to the mark');
 assert.ok(Math.abs(revealed.middle-revealed.view)<24,JSON.stringify(revealed));
 console.log(JSON.stringify({passed:true,checks:['canonical range quote','uppercase CSS','responsive text stable','no DOM wrapping','CSS highlight painted','mutation invalidates','indexed while a widget animates','no blink on change','growth indexed','reader-caused rewrites kept','typesetting math','capture while its paragraph changes','mark clicks are not reading clicks','reveal centres the mark']}));
 win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
