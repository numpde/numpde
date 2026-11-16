// CDP transport adapted from best-practices/tools/check-browser.mjs.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const files=new Map([
 ['/index.html',['index.html','text/html']],
 ['/data/repos.json',['data/repos.json','application/json']],
 ['/data/neighborhoods.json',['data/neighborhoods.json','application/json']],
 ['/assets/graph-controls.js',['assets/graph-controls.js','text/javascript']],
 ['/assets/graph-fisheye.js',['assets/graph-fisheye.js','text/javascript']],
 ['/assets/vendor/cytoscape-3.34.4.min.js',['assets/vendor/cytoscape-3.34.4.min.js','text/javascript']],
]);
const server=createServer((req,res)=>{
 const file=files.get(new URL(req.url,'http://localhost').pathname);
 if(!file){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':file[1]});
 res.end(readFileSync(join(root,file[0])));
});
server.listen(0,'127.0.0.1');
await once(server,'listening');
const pageURL=`http://127.0.0.1:${server.address().port}/index.html`;
const profile=mkdtempSync(join(tmpdir(),'repos-graph-browser-'));
const browser=spawn(process.env.CHROMIUM||'chromium',[
 '--headless','--disable-gpu','--disable-background-networking',
 '--remote-debugging-pipe','--no-first-run','--no-default-browser-check',
 `--user-data-dir=${profile}`,
],{stdio:['ignore','ignore','pipe','pipe','pipe']});
let browserOutput='';
browser.stderr.on('data',chunk=>{browserOutput=(browserOutput+chunk).slice(-4000);});
const closed=new Promise(resolve=>browser.once('close',resolve));
const requests=new Map(),errors=[];
let sequence=0,buffer='',session,connected=false;
function receive(message){
 const request=requests.get(message.id);
 if(request){
  requests.delete(message.id);
  if(message.error)request.reject(Error(`${request.method}: ${message.error.message} (code ${message.error.code})`));
  else request.resolve(message.result);
 }else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);
}
function disconnected(){
 connected=false;
 for(const request of requests.values())request.reject(Error(`Cannot complete ${request.method}; the Chromium debug connection closed before replying.`));
 requests.clear();
}
if(browser){
 browser.stdio[4].setEncoding('utf8');
 browser.stdio[4].on('data',chunk=>{
  buffer+=chunk;
  let end;
  while((end=buffer.indexOf('\0'))>=0){
   receive(JSON.parse(buffer.slice(0,end)));
   buffer=buffer.slice(end+1);
  }
 });
 browser.on('exit',disconnected);
}
function call(method,params={},sessionId=session){
 if(!connected)return Promise.reject(Error('The Chromium debug connection is not open.'));
 return new Promise((resolve,reject)=>{
  const id=++sequence;
  requests.set(id,{resolve,reject,method});
  send({id,method,params,sessionId:sessionId??undefined});
 });
}
function send(message){
 const encoded=JSON.stringify(message);
 browser.stdio[3].write(encoded+'\0');
}
async function evaluate(expression){
 const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
 return result.result.value;
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const nextFrames=()=>evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
async function waitFor(expression,timeout=5000){
 const end=Date.now()+timeout;
 do{
  if(await evaluate(expression))return;
  await delay(30);
 }while(Date.now()<end);
 const state=await evaluate(`({
  document:document.readyState,visibility:document.visibilityState,
  graphBusy:document.querySelector('#graph')?.getAttribute('aria-busy'),
 })`);
 const failures=errors.slice(-3).map(error=>error.exception?.description?.slice(0,300)||error.text);
 throw Error(`Browser check timed out waiting for ${expression}; page=${JSON.stringify(state)}; runtime errors=${JSON.stringify(failures)}`);
}
const waitReady=()=>waitFor(`!!document.querySelector('#graph') &&
 getComputedStyle(document.querySelector('#graph')).visibility==='visible' &&
 document.querySelector('#graph').getAttribute('aria-busy')==='false'`);
async function checkStartupMotion(){
 await waitReady();
 assert.equal(await evaluate('liveFrame!==null'),true,'The force layout must start on page load without a drag.');
 const loading=await view();
 await delay(300);
 const moving=await view();
 const visibleMotion=moving.positions.filter((p,i)=>Math.hypot(p.x-loading.positions[i].x,p.y-loading.positions[i].y)*loading.zoom>=4).length;
 assert.ok(visibleMotion>=loading.positions.length/4,`Initial settling must visibly move at least a quarter of nodes by 4 screen pixels; observed ${visibleMotion}.`);
 await waitFor('liveFrame===null',20000);
 console.log(`Startup motion: ${visibleMotion}/${loading.positions.length} nodes moved at least 4 screen pixels in 300 ms.`);
}
async function pressKey(key,code,windowsVirtualKeyCode){
 await call('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode});
 await call('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode});
}
async function choose(selector,value){
 await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.focus();input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await nextFrames();
}
const deadline=setTimeout(()=>browser.kill(),120000);
const view=()=>evaluate(`({positions:cy.nodes().map(n=>({id:n.id(),...n.position()})),zoom:cy.zoom(),pan:cy.pan()})`);
const visible=()=>evaluate(`cy.nodes().every(n=>{const b=n.renderedBoundingBox();return b.x1>=-1&&b.y1>=-1&&b.x2<=cy.width()+1&&b.y2<=cy.height()+1})`);
async function screenshot(name){
 const shot=await call('Page.captureScreenshot',{format:'png'});
 writeFileSync(join(tmpdir(),name),Buffer.from(shot.data,'base64'));
}
async function drag(point,dx,dy,touch=false,hold=0){
 if(touch)await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1}]});
 else{
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
 }
 for(let step=1;step<=6;step++){
  const p={x:point.x+dx*step/6,y:point.y+dy*step/6};
  if(touch)await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...p,id:1}]});
  else await call('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...p});
 }
 if(hold)await delay(hold);
 const held=await view();
 if(touch)await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 else await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:point.x+dx,y:point.y+dy});
 await nextFrames();
 return held;
}
try{
 await once(browser,'spawn');
 connected=true;
 const {targetId}=await call('Target.createTarget',{url:'about:blank'});
 ({sessionId:session}=await call('Target.attachToTarget',{targetId,flatten:true}));
 await call('Page.enable');
 await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.openedRepositories=[];window.open=(url,target,features)=>{window.openedRepositories.push({url,target,features});return null;};`});
 await call('Runtime.enable');
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:pageURL});
 await checkStartupMotion();
 const inventory=JSON.parse(readFileSync(join(root,'data/repos.json'),'utf8'));
 const neighborhoods=JSON.parse(readFileSync(join(root,'data/neighborhoods.json'),'utf8'));
 assert.equal(await evaluate('cy.nodes().length'),inventory.projects.length);
 assert.equal(await evaluate(`cy.nodes().filter(n=>n.data('label')==='rna-sieve').length`),1,'Fork and upstream must appear as one RNA-Sieve project.');
 assert.equal(await evaluate(`cy.nodes().filter(n=>n.id().startsWith('github:')).length`),0,'Repository identities must not remain graph nodes.');
 assert.equal(await evaluate('cy.edges().length'),neighborhoods.embedded.edge_count);
 const expectedEmbedded=neighborhoods.embedded.pair_indices.map(i=>{
  const [source,target]=neighborhoods.pairs[i];return `neighbor:${source}:${target}`;
 }).sort();
 assert.deepEqual(await evaluate(`cy.edges().map(e=>e.id()).sort()`),expectedEmbedded);
 assert.equal(await evaluate(`cy.nodes().every(n=>n.degree()>=2)&&cy.edges().every(e=>!e.data('directed'))`),true);
 assert.equal(await evaluate(`document.querySelector('#views a[aria-current="page"]').dataset.view`),'embedded');
 assert.equal(await evaluate('graph.innerText.trim()'),'');
 assert.equal(await evaluate(`cy.edges().every(e=>e.style('label')==='')`),true);
 assert.equal(await visible(),true,'Initial fit must include labels and all isolated nodes.');
 const overlaps=await evaluate(`(()=>{
  const nodes=cy.nodes().toArray(),pairs=[];
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
   const a=nodes[i].boundingBox({includeOverlays:false}),b=nodes[j].boundingBox({includeOverlays:false});
   if(Math.min(a.x2,b.x2)-Math.max(a.x1,b.x1)>.5&&Math.min(a.y2,b.y2)-Math.max(a.y1,b.y1)>.5)pairs.push([nodes[i].id(),nodes[j].id()]);
  }
  return pairs;
 })()`);
 await screenshot('repos-graph-desktop.png');
 assert.equal(await evaluate(`cy.edges().every(e=>{const b=e.renderedBoundingBox();return b.w+b.h>.01})`),true,'Every edge must have drawable geometry.');
 assert.equal(overlaps.length,0,`Label-aware arrangement has ${overlaps.length} overlapping pairs: ${JSON.stringify(overlaps)}.`);
 const initial=await view();
 await delay(200);
 assert.deepEqual(await view(),initial,'An idle graph must stay still.');
 console.log('Initial fitted graph: repository labels only, all nodes and edges, no node overlaps.');

 await evaluate('startLiveLayout()');
 await waitFor('liveFrame===null',20000);
 const restarted=await view();
 const restartShift=Math.max(...restarted.positions.map((p,i)=>Math.hypot(p.x-initial.positions[i].x,p.y-initial.positions[i].y)*initial.zoom));
 assert.ok(restartShift<1,`Restarting untouched physics must not rearrange the graph; largest shift ${restartShift.toFixed(2)} screen pixels.`);
 console.log(`Untouched restart: largest node movement ${restartShift.toFixed(2)} screen pixels.`);

 console.log('Embedded view contains the exact 2% plus two-nearest-neighbor union; all nodes have at least two neighbors and settle on load.');

 const appearanceBefore=await view();
 await choose('#color-by','domain');
 assert.deepEqual(await view(),appearanceBefore,'Color changes must leave positions and camera untouched.');
 assert.ok(await evaluate(`new Set(cy.nodes().map(n=>n.style('background-color'))).size>3`));
 assert.equal(await evaluate(`new URL(location.href).searchParams.get('color')`),'domain');
 await choose('#size-by','commits');
 assert.deepEqual((await view()).pan,appearanceBefore.pan,'Size changes must preserve the camera.');
 const mostCommits=inventory.projects.reduce((a,b)=>a.user_work.commit_count>b.user_work.commit_count?a:b);
 const zeroCommits=inventory.projects.find(p=>p.user_work.commit_count===0);
 assert.equal(await evaluate(`cy.getElementById(${JSON.stringify(mostCommits.id)}).data('height')>cy.getElementById(${JSON.stringify(zeroCommits.id)}).data('height')`),true);
 assert.equal(await evaluate(`cy.nodes().every(n=>n.data('width')>=n.data('labelWidth')&&n.style('font-size')==='13px')`),true);
 await choose('#size-by','difficulty');
 assert.equal(await evaluate(`cy.getElementById('project:songlab-cal/rna-sieve').style('border-style')`),'dashed','Unknown contribution difficulty must not masquerade as zero.');
 await choose('#size-by','none');
 await choose('#color-by','none');
 await evaluate(`document.querySelector('#edge-filter summary').focus();document.querySelector('#edge-filter summary').click()`);
 await evaluate(`document.querySelector('input[name="rules"][value="nearest"]').click()`);
 await nextFrames();
 assert.equal(await evaluate(`cy.edges(':visible').length`),neighborhoods.embedded.cutoff_edge_count);
 await evaluate(`document.querySelector('input[name="rules"][value="nearest"]').click();document.querySelector('input[name="rules"][value="cutoff"]').click()`);
 await nextFrames();
 assert.equal(await evaluate(`cy.edges(':visible').length`),neighborhoods.embedded.nearest_pair_indices.length,'Nearest-only must retain exactly the deduplicated nearest-neighbor rule.');
 const filterCamera=await view();
 await evaluate(`document.querySelector('input[name="rules"][value="nearest"]').click()`);
 await nextFrames();
 assert.equal(await evaluate(`cy.edges(':visible').length`),0);
 assert.equal(await evaluate('cy.nodes().length'),inventory.projects.length,'Empty edge selection must retain every project node.');
 assert.deepEqual(await view(),filterCamera,'Edge filtering must not rearrange the graph or camera.');
 const noEdgePositions=await evaluate(`(()=>{const source=cy.getElementById('project:numpde/magnet');const positions=cy.nodes().not(source).map(n=>({id:n.id(),...n.position()}));source.position({x:source.position('x')+20,y:source.position('y')});startLiveLayout(source);return positions})()`);
 await nextFrames();
 assert.deepEqual(await evaluate(`cy.nodes().not(cy.getElementById('project:numpde/magnet')).map(n=>({id:n.id(),...n.position()}))`),noEdgePositions,'Filtered-out edges must not pull their former neighbors.');
 await waitFor('liveFrame===null',20000);
 await choose('#size-by','connections');
 await choose('#color-by','connections');
 assert.equal(await evaluate(`cy.nodes().every(n=>n.data('height')===16&&n.style('border-style')==='solid')`),true,'Known zero neighbors must remain legible solid-outline nodes.');
 await evaluate(`document.querySelector('input[name="rules"][value="nearest"]').click();document.querySelector('input[name="rules"][value="cutoff"]').click()`);
 await choose('#size-by','none');
 await choose('#color-by','none');
 await pressKey('Escape','Escape',27);
 assert.equal(await evaluate(`document.querySelector('#edge-filter').open`),false);
 assert.equal(await evaluate(`document.activeElement===document.querySelector('#edge-filter summary')`),true);
 assert.equal(await evaluate(`cy.edges(':visible').length`),neighborhoods.embedded.edge_count);
 console.log('Color/size mappings, unknown scores, both embedding inclusion rules, empty filters, and camera preservation work.');

 const fitted=await view();
 const pointer={x:720,y:500};
 const anchor={x:(pointer.x-fitted.pan.x)/fitted.zoom,y:(pointer.y-fitted.pan.y)/fitted.zoom};
 await call('Input.dispatchMouseEvent',{type:'mouseWheel',...pointer,deltaX:0,deltaY:-120});
 await waitFor(`cy.zoom()>${fitted.zoom}`);
 await delay(180);
 const zoomed=await view();
 assert.deepEqual(zoomed.positions,fitted.positions,'Zoom must not rearrange the graph.');
 assert.ok(Math.abs(anchor.x*zoomed.zoom+zoomed.pan.x-pointer.x)<2);
 assert.ok(Math.abs(anchor.y*zoomed.zoom+zoomed.pan.y-pointer.y)<2);
 const blank=await evaluate(`(()=>{
  for(let y=30;y<200;y+=30)for(let x=30;x<200;x+=30){
   if(!graph.contains(document.elementFromPoint(x,y)))continue;
   if(cy.nodes().every(n=>{const b=n.renderedBoundingBox();return x<b.x1-5||x>b.x2+5||y<b.y1-5||y>b.y2+5}))return {x,y};
  }
  throw Error('No blank pan point in the test region.');
 })()`);
 await drag(blank,70,45);
 const panned=await view();
 assert.deepEqual(panned.positions,zoomed.positions);
 assert.equal(panned.zoom,zoomed.zoom);
 assert.ok(Math.abs(panned.pan.x-zoomed.pan.x-70)<2);
 assert.ok(Math.abs(panned.pan.y-zoomed.pan.y-45)<2);
 console.log('Wheel zoom stays anchored to the pointer; background dragging pans without moving nodes.');

 await evaluate(`cy.zoom(1.1);cy.center(cy.getElementById('project:numpde/magnet'));selectNode(null)`);
 await nextFrames();
 const point=await evaluate(`cy.getElementById('project:numpde/magnet').renderedPosition()`);
 const beforeDrag=await view();
 const neighbors=await evaluate(`cy.getElementById('project:numpde/magnet').neighborhood('node').map(n=>n.id())`);
 const distant=await evaluate(`(()=>{let near=cy.getElementById('project:numpde/magnet');for(let i=0;i<2;i++)near=near.union(near.neighborhood());return cy.nodes().difference(near).map(n=>n.id())})()`);
 const heldDrag=await drag(point,90,55,false,220);
 const afterDrag=await view();
 assert.deepEqual(afterDrag.pan,beforeDrag.pan);
 assert.equal(afterDrag.zoom,beforeDrag.zoom);
 const a=beforeDrag.positions.find(p=>p.id==='project:numpde/magnet');
 const b=heldDrag.positions.find(p=>p.id===a.id);
 assert.ok(Math.abs((b.x-a.x)*afterDrag.zoom-90)<2);
 assert.ok(Math.abs((b.y-a.y)*afterDrag.zoom-55)<2);
 assert.ok(neighbors.some(id=>{const before=beforeDrag.positions.find(p=>p.id===id),during=heldDrag.positions.find(p=>p.id===id);return Math.hypot(during.x-before.x,during.y-before.y)>.1}),'Connected neighbors must respond while the node is held.');
 assert.deepEqual(heldDrag.pan,beforeDrag.pan);
 assert.equal(heldDrag.zoom,beforeDrag.zoom);
 assert.equal(await evaluate('selected===null'),true,'Dragging must not turn into click selection.');
 assert.equal(await evaluate('openedRepositories.length'),0,'Dragging must never open a repository.');
 await waitFor('liveFrame===null',20000);
 const rested=await view();
 const distantShifts=distant.map(id=>{const before=beforeDrag.positions.find(p=>p.id===id),after=rested.positions.find(p=>p.id===id);return Math.hypot(after.x-before.x,after.y-before.y)*rested.zoom}).sort((a,b)=>a-b);
 const medianDistant=distantShifts[Math.floor(distantShifts.length/2)];
 assert.ok(medianDistant<2,`Dragging one node must not rearrange unrelated regions; median distant movement ${medianDistant.toFixed(2)} screen pixels.`);
 assert.ok(distantShifts.every(distance=>distance===0),'Every node outside the affected neighborhood must stay fixed.');
 console.log(`Drag locality: median distant movement ${medianDistant.toFixed(2)} screen pixels.`);
 await delay(180);
 assert.deepEqual(await view(),rested,'The force arrangement must settle after release.');
 const settledPoint=await evaluate(`cy.getElementById('project:numpde/magnet').renderedPosition()`);
 await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...settledPoint});
 await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...settledPoint});
 assert.equal(await evaluate(`selected?.id()`),a.id);
 assert.equal(await evaluate(`document.querySelector('#node-info').hidden`),false,'First click must show project information.');
 assert.equal(await evaluate('openedRepositories.length'),0,'First click must select without opening a tab.');
 await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...settledPoint});
 await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...settledPoint});
 assert.deepEqual(await evaluate('openedRepositories'),[{url:'https://github.com/numpde/magnet',target:'_blank',features:'noopener,noreferrer'}],'A second click on the selected node must open its representative repository.');
 const clicked=await view();
 await pressKey('ArrowRight','ArrowRight',39);
 const nudged=await view();
 assert.deepEqual(nudged.pan,clicked.pan);
 assert.equal(nudged.zoom,clicked.zoom);
 await waitFor('liveFrame===null',20000);
 const settledNudge=await view();
 const oldSelected=clicked.positions.find(p=>p.id===a.id),newSelected=settledNudge.positions.find(p=>p.id===a.id);
 assert.ok(Math.hypot(newSelected.x-oldSelected.x,newSelected.y-oldSelected.y)*clicked.zoom>1,'Keyboard nudging must retain a visible position change after settling.');
 await pressKey('Escape','Escape',27);
 assert.equal(await evaluate('selected===null'),true);
 assert.deepEqual(await view(),settledNudge,'Escape must not reset the layout or camera.');
 await screenshot('repos-graph-detail.png');
 console.log('Dragging holds the node under the pointer, moves connected neighbors, and settles without reframing; keyboard movement reheats it.');

 await evaluate('startLiveLayout();arrangeGraph();arrangeGraph();arrangeGraph()');
 await waitReady();
 await waitFor('liveFrame===null',20000);
 assert.equal(await visible(),true);
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await nextFrames();
 await waitFor('cy.width()===390');
 assert.equal(await visible(),true,'A viewport resize must refit instead of leaving the graph outside the screen.');
 await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await call('Page.navigate',{url:pageURL});
 await checkStartupMotion();
 await evaluate(`document.querySelector('#edge-filter summary').focus();document.querySelector('#edge-filter summary').click()`);
 await nextFrames();
 assert.equal(await evaluate(`(()=>{const b=document.querySelector('#edge-options').getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.bottom<=innerHeight})()`),true,'The edge checklist must fit on a narrow viewport.');
 await screenshot('repos-graph-controls-mobile.png');
 await pressKey('Escape','Escape',27);
 assert.equal(await visible(),true);
 await screenshot('repos-graph-mobile.png');
 await evaluate(`cy.zoom(1.1);cy.center(cy.getElementById('project:numpde/magnet'));selectNode(null)`);
 await nextFrames();
 const touchPoint=await evaluate(`cy.getElementById('project:numpde/magnet').renderedPosition()`);
 const touchBefore=await view();
 const touchHeld=await drag(touchPoint,55,40,true,220);
 const touchAfter=await view();
 assert.deepEqual(touchAfter.pan,touchBefore.pan);
 assert.equal(touchAfter.zoom,touchBefore.zoom);
 const ta=touchBefore.positions.find(p=>p.id==='project:numpde/magnet');
 const tb=touchHeld.positions.find(p=>p.id===ta.id);
 assert.ok(Math.abs((tb.x-ta.x)*touchAfter.zoom-55)<3);
 assert.ok(Math.abs((tb.y-ta.y)*touchAfter.zoom-40)<3);
 assert.ok(touchHeld.positions.some((p,i)=>p.id!==ta.id&&Math.hypot(p.x-touchBefore.positions[i].x,p.y-touchBefore.positions[i].y)>.1),'Touch dragging must also reheat the force layout.');
 await waitFor('liveFrame===null',20000);
 const panPoint=await evaluate(`(()=>{
  for(let y=25;y<cy.height()-80;y+=30)for(let x=25;x<cy.width()-70;x+=30){
   if(!graph.contains(document.elementFromPoint(x,y)))continue;
   if(cy.nodes().every(n=>{const b=n.renderedBoundingBox();return x<b.x1-36||x>b.x2+36||y<b.y1-36||y>b.y2+36}))return {x,y};
  }
  throw Error('No blank touch-pan point in the test region.');
 })()`);
 const panBefore=await view();
 await drag(panPoint,45,35,true);
 const panAfter=await view();
 assert.ok(panAfter.positions.every((p,i)=>p.x===panBefore.positions[i].x&&p.y===panBefore.positions[i].y),'Touch background panning must not drag a node.');
 assert.equal(panAfter.zoom,panBefore.zoom);
 assert.ok(Math.abs(panAfter.pan.x-panBefore.pan.x-45)<3);
 assert.ok(Math.abs(panAfter.pan.y-panBefore.pan.y-35)<3);
 const pinchCenter={x:195,y:422};
 const pinchBefore=await view();
 const pinchAnchor={x:(pinchCenter.x-pinchBefore.pan.x)/pinchBefore.zoom,y:(pinchCenter.y-pinchBefore.pan.y)/pinchBefore.zoom};
 await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:160,y:422,id:1},{x:230,y:422,id:2}]});
 for(const spread of [45,55,65])await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:195-spread,y:422,id:1},{x:195+spread,y:422,id:2}]});
 await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await nextFrames();
 const pinchAfter=await view();
 assert.ok(pinchAfter.zoom>pinchBefore.zoom,'A two-finger pinch must zoom the graph.');
 assert.deepEqual(pinchAfter.positions,pinchBefore.positions);
 assert.ok(Math.abs(pinchAnchor.x*pinchAfter.zoom+pinchAfter.pan.x-pinchCenter.x)<3);
 assert.ok(Math.abs(pinchAnchor.y*pinchAfter.zoom+pinchAfter.pan.y-pinchCenter.y)<3);
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 assert.equal(await evaluate('graph.innerText.trim()'),'');
 assert.deepEqual(errors,[]);
 console.log('Repeated arrangements, narrow resize, reduced motion, touch drag/pan, and pinch zoom work without page exceptions.');
 await call('Emulation.setEmulatedMedia',{features:[]});
 const beforeSwitch=await view();
 await evaluate('window.originalGraph=cy;window.originalDocument=document');
 await evaluate(`document.querySelector('#views a[data-view="curated"]').click()`);
 await waitFor(`location.search==='?view=curated'`);
 await checkStartupMotion();
 assert.equal(await evaluate('cy===window.originalGraph&&document===window.originalDocument'),true,'Switching edge sets must retain the graph instance and document.');
 assert.deepEqual((await view()).pan,beforeSwitch.pan,'Live switching must preserve the camera.');
 assert.equal((await view()).zoom,beforeSwitch.zoom);
 assert.deepEqual(await evaluate(`cy.edges().map(e=>e.id()).sort()`),inventory.links.map(e=>e.id).sort());
 assert.equal(await evaluate('neighborhoodMap'),null);
 assert.equal(await evaluate(`document.querySelector('#views a[aria-current="page"]').dataset.view`),'curated');
 await evaluate(`document.querySelector('#edge-filter summary').focus();document.querySelector('#edge-filter summary').click();document.querySelector('.filter-actions button:last-child').click();document.querySelector('input[name="types"][value="complements"]').click()`);
 await evaluate(`for(const name of ['basis','confidence']){const inputs=[...document.querySelectorAll('input[name="'+name+'"]')];for(const input of inputs)input.checked=input.value===(name==='basis'?'prospective':'high');inputs[0].dispatchEvent(new Event('change',{bubbles:true}))}`);
 await nextFrames();
 const expectedProspective=inventory.links.filter(e=>e.type==='complements'&&[e,...(e.additional_interpretations??[])].some(c=>c.basis==='prospective'&&c.confidence==='high')).map(e=>e.id).sort();
 assert.deepEqual(await evaluate(`cy.edges(':visible').map(e=>e.id()).sort()`),expectedProspective,'Curated filters must match basis and confidence on the same supporting interpretation.');
 assert.equal(await evaluate('cy.nodes().length'),inventory.projects.length);
 await choose('#color-by','domain');
 await evaluate(`document.querySelector('#views a[data-view="embedded"]').click()`);
 await waitFor(`new URL(location.href).searchParams.get('view')==='embedded'`);
 await waitReady();
 await waitFor('liveFrame===null',20000);
 assert.deepEqual(await evaluate(`cy.edges().map(e=>e.id()).sort()`),expectedEmbedded);
 assert.equal(await evaluate(`document.querySelector('#color-by').value`),'domain','Appearance choices must survive switching views.');
 assert.equal(await evaluate('cy===window.originalGraph&&document===window.originalDocument'),true,'Switching back must not reload the page.');
 await evaluate('history.back()');
 await waitFor(`new URL(location.href).searchParams.get('view')==='curated'`);
 await nextFrames();
 assert.deepEqual(await evaluate(`cy.edges(':visible').map(e=>e.id()).sort()`),expectedProspective,'Back must restore the curated edge filters in place.');
 await evaluate('history.forward()');
 await waitFor(`new URL(location.href).searchParams.get('view')==='embedded'`);
 await nextFrames();
 assert.deepEqual(await evaluate(`cy.edges().map(e=>e.id()).sort()`),expectedEmbedded);
 await evaluate(`document.querySelector('#views a[data-view="curated"]').click();document.querySelector('#views a[data-view="embedded"]').click()`);
 await waitFor('liveFrame===null',20000);
 assert.equal(await evaluate('cy===window.originalGraph&&document===window.originalDocument'),true);
 assert.deepEqual(await evaluate(`cy.edges().map(e=>e.id()).sort()`),expectedEmbedded,'Rapid switching must settle the final requested edge set.');
 assert.equal(await evaluate('graph.innerText.trim()'),'');
 assert.deepEqual(errors,[]);
 console.log('Both edge sets switch live without reloading; appearance, camera, history, and rapid changes remain consistent.');
 await call('Target.activateTarget',{targetId},null);
 const {targetId:backgroundTarget}=await call('Target.createTarget',{url:pageURL,background:true},null);
 ({sessionId:session}=await call('Target.attachToTarget',{targetId:backgroundTarget,flatten:true},null));
 await call('Runtime.enable');
 await waitFor(`document.readyState==='complete' && typeof cy!=='undefined' && cy!==null`);
 assert.equal(await evaluate('document.hidden'),true,'The background-load case must actually begin hidden.');
 await call('Target.activateTarget',{targetId:backgroundTarget},null);
 await waitFor('!document.hidden');
 await checkStartupMotion();
 assert.deepEqual(errors,[]);
 console.log('A graph loaded in a background tab visibly starts settling when activated.');
 await evaluate('arrangeGraph(true)');
 await waitReady();
 const earlyDrag=await evaluate(`(()=>{
  const source=cy.getElementById('project:numpde/magnet');
  initialMotion=false;
  startLiveLayout(source);
  const untouched=cy.nodes().filter(n=>!liveNeighborhood.has(n.id()));
  source.position({x:source.position('x')+30,y:source.position('y')});
  return untouched.map(n=>({id:n.id(),...n.position()}));
 })()`);
 await nextFrames();
 assert.deepEqual(await evaluate(`cy.nodes().filter(n=>!liveNeighborhood.has(n.id())).map(n=>({id:n.id(),...n.position()}))`),earlyDrag,'Interacting during startup must also stop global rearrangement.');
 await waitFor('liveFrame===null',20000);
 console.log('An interaction during initial settling also confines relaxation to its neighborhood.');
 console.log('Screenshots: /tmp/repos-graph-desktop.png, /tmp/repos-graph-detail.png, /tmp/repos-graph-mobile.png');
} catch(error){
 console.error(browserOutput);
 throw error;
} finally{
 clearTimeout(deadline);
 browser.kill();
 await closed;
 server.close();
 rmSync(profile,{recursive:true,force:true});
}
