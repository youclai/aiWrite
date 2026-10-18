/* Quick check: does the editor's #sheet overlay block clicks due to CSS overriding [hidden]? */
const BASE = 'http://127.0.0.1:9222';
const EXPR = `(async()=>{
  const A=globalThis.NOVEL_APP;
  A.go('#/editor/2/2');
  await new Promise(r=>setTimeout(r,500));
  const sh=document.querySelector('#sheet');
  const cs=sh?getComputedStyle(sh):null;
  // Also check: what element is at the center of the viewport (where textarea should be)?
  const cx=Math.round(innerWidth/2), cy=Math.round(innerHeight/2);
  const atPoint=document.elementFromPoint(cx,cy);
  return JSON.stringify({
    sheetExists:!!sh, hidden:sh?sh.hidden:null,
    display:cs?cs.display:null, position:cs?cs.position:null,
    zIndex:cs?cs.zIndex:null, pointerEvents:cs?cs.pointerEvents:null,
    centerElement: atPoint ? atPoint.tagName+'#'+atPoint.id+'.'+atPoint.className : 'NONE'
  });
})()`;
(async()=>{const t=await(await fetch(BASE+'/json')).json();const p=t.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);const ws=new WebSocket(p.webSocketDebuggerUrl);let id=0;const pm=new Map();const send=(m,p2)=>new Promise((r,j)=>{const i=++id;pm.set(i,{res:r,rej:j});ws.send(JSON.stringify({id:i,method:m,params:p2||{}}))});ws.onmessage=ev=>{const msg=JSON.parse(ev.data);if(msg.id&&pm.has(msg.id)){const pp=pm.get(msg.id);pm.delete(msg.id);msg.error?pp.rej(new Error(JSON.stringify(msg.error))):pp.res(msg.result)}};await new Promise(r=>ws.addEventListener('open',r));const r=await send('Runtime.evaluate',{expression:EXPR,returnByValue:true,awaitPromise:true});console.log(r.result.value);ws.close()})().catch(e=>console.log('ERR',e.message));
