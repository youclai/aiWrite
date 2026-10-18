/* devtools-screen-dump.cjs —— 单次 evaluate 一次性 dump 启动后界面原样（不手动 render）。 */
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
  const expr = `(function(){
    var el=document.getElementById('screen');
    var st=window.NOVEL_APP&&NOVEL_APP.state;
    return JSON.stringify({
      hash: location.hash,
      booted: st&&st.booted, ready: st&&st.report&&st.report.ready, err: st&&st.report&&st.report.error,
      hasScreen: !!el,
      screenLen: el?el.innerHTML.length:-1,
      screen: el?(el.innerHTML||'').slice(0,500):null,
      tabs: document.querySelectorAll('[data-tab]').length
    });
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) console.log('EXC', JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
  else console.log(r.result.value);
  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
