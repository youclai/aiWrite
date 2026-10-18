/* devtools-freeze2.cjs —— 受控复现：直接建书(绕 prompt)→进作品→用超时 evaluate 探测主线程是否被 chapters 渲染阻塞。 */
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
  function rawEval(expr) { return send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r.exceptionDetails ? 'EXC:' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text) : (r.result ? r.result.value : r)); }
  function evalTimeout(expr, ms) { return Promise.race([rawEval(expr), new Promise(r => setTimeout(() => r('<<TIMEOUT/BLOCKED>>'), ms))]); }

  console.log('1) 建测试书(绕 prompt):', await evalTimeout("(async function(){var id=await NOVEL_DB.createBook({title:'联调测试ZZ'});return 'id='+id})()", 4000));
  console.log('2) 导航 #/book/<id>:', await evalTimeout("(function(){var b=window.__bookid; location.hash='#/book/'+(window.__lastbid||0); return 'hashset='+location.hash})()", 4000));
  // 重新取真实 id
  console.log('2b) 取到测试书 id 并导航:', await evalTimeout("(async function(){var bs=await NOVEL_DB.listBooks(); var t=bs.filter(function(x){return x.title==='联调测试ZZ'})[0]; if(!t)return 'NO_TESTBOOK'; location.hash='#/book/'+t.id; return 'nav id='+t.id+' hash='+location.hash})()", 4000));
  await new Promise(r => setTimeout(r, 1200));
  console.log('3) 导航后探测主线程(1+1):', await evalTimeout("String(1+1)", 3000));
  console.log('4) 读 #screen:', await evalTimeout("(function(){var el=document.getElementById('screen');return JSON.stringify({len:el?el.innerHTML.length:-1,head:(el?(el.innerHTML||''):'').slice(0,200)})})()", 3000));
  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
