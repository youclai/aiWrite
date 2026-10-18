/* devtools-nav-probe.cjs —— 真机驱动 hash 切页并 dump 各视图是否渲染，验证“点击无效果”已修复。 */
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
  for (const h of ['#/shelf', '#/settings', '#/me', '#/shelf']) {
    const r = await ev("(async function(){location.hash='" + h + "';await new Promise(x=>setTimeout(x,500));var el=document.getElementById('screen');var t=document.querySelector('#screen .htitle');return JSON.stringify({hash:location.hash,len:el?el.innerHTML.length:-1,title:t?t.textContent:null,booting:el?/加载中/.test(el.innerHTML):null})})()");
    console.log(h + ' -> ' + r);
  }
  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
