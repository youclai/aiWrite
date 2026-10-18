/* devtools-dialog-probe.cjs —— 实测 window.prompt/confirm 是否阻塞 WebView 主线程（决定 #2 冻结是否由此）。
   若返回 <<BLOCKED>> 说明同步弹窗把渲染线程挂住。测完需 force-stop 恢复。 */
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
  const rawEval = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r.exceptionDetails ? 'EXC:' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text) : (r.result ? r.result.value : r));
  const to = (expr, ms) => Promise.race([rawEval(expr), new Promise(r => setTimeout(() => r('<<BLOCKED>>'), ms))]);

  console.log('prompt:', await to("(function(){var r=window.prompt('联调标题','默认');return 'returned='+JSON.stringify(r)})()", 4000));
  console.log('confirm:', await to("(function(){var r=window.confirm('联调确认?');return 'returned='+JSON.stringify(r)})()", 4000));
  console.log('主线程 1+1:', await to("String(1+1)", 3000));
  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
