/* devtools-freeze-probe.cjs —— 复现“进入作品后界面冻结”：挂钩全局错误，导航到真实书/设定/me，dump 界面与错误。 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
async function main() {
  const targets = await (await fetch(BASE + '/json')).json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET'); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.addEventListener('message', ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const pp = pending.get(msg.id); pending.delete(msg.id); msg.error ? pp.rej(new Error(JSON.stringify(msg.error))) : pp.res(msg.result); } });
  await new Promise((ok, err) => { ws.addEventListener('open', ok); ws.addEventListener('error', err); });
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text);
    return r.result ? r.result.value : r;
  }

  // 装全局错误钩子
  console.log('=== hook errs ===');
  console.log(await ev("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push('onerror: '+(e.message||e.error))});window.addEventListener('unhandledrejection',function(e){window.__errs.push('reject: '+((e.reason&&(e.reason.message||e.reason))||e.reason))});return 'HOOKED'})()"));

  console.log('=== listBooks ===');
  console.log(await ev("(async function(){try{var b=await NOVEL_DB.listBooks();return JSON.stringify(b.map(function(x){return {id:x.id,title:x.title,ch:x.chapter_count}}))}catch(e){return 'listBooks ERR '+e.message}})()"));

  // 导航到第一本书
  console.log('=== go #/book/<first> ===');
  console.log(await ev("(async function(){window.__errs=[];var b=await NOVEL_DB.listBooks();if(!b.length)return 'NO_BOOKS';location.hash='#/book/'+b[0].id;await new Promise(r=>setTimeout(r,800));var el=document.getElementById('screen');return JSON.stringify({hash:location.hash,len:el?el.innerHTML.length:-1,head:(el?(el.innerHTML||''):'').slice(0,240),errs:window.__errs})})()"));

  // 导航到设定（复现点击设定无效果）
  console.log('=== go #/settings（复现设定回弹） ===');
  console.log(await ev("(async function(){window.__errs=[];location.hash='#/settings';await new Promise(r=>setTimeout(r,600));return JSON.stringify({hashAfter:location.hash,errs:window.__errs})})()"));

  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
