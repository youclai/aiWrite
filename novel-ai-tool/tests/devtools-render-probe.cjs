/* devtools-render-probe.cjs —— 定位 render() 为何没替换“加载中…”占位：查 App.el 指向 + 手动 render 抛错。 */
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
  console.log('=== App.el 指向 ===');
  console.log(await ev("(function(){var a=window.NOVEL_APP;var el=document.getElementById('screen');return JSON.stringify({appEl:a?a.el?'exists':'NULL/undefined':'NO APP',sameAsScreen:a&&a.el?a.el===el:'NA',appElTag:a&&a.el?a.el.id+'/'+a.el.className:'NA'})})()"));
  console.log('=== #screen outerHTML 前200 ===');
  console.log(await ev("(function(){var el=document.getElementById('screen');return el?el.outerHTML.slice(0,200):'NO #screen'})()"));
  console.log('=== 直接 try render() ===');
  console.log(await ev("(function(){try{NOVEL_APP.render();return 'render() 同步未抛';}catch(e){return 'render THROW: '+(e&&e.stack||e)}})()"));
  console.log('=== render 后 400ms #screen ===');
  console.log(await ev("(async function(){await new Promise(r=>setTimeout(r,400));var el=document.getElementById('screen');return 'len='+(el?el.innerHTML.length:'NOEL')+' :: '+(el?(el.innerHTML||'').slice(0,200):'')})()"));
  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
