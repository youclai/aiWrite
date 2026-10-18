/* devtools-ui-probe.cjs —— 读取设备 App 当前界面 DOM 与启动判定，定位"数据层未就绪 + 点击无效"。
   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>。 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

async function main() {
  const res = await fetch(BASE + '/json');
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET', JSON.stringify(targets)); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.addEventListener('message', ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const pp = pending.get(msg.id); pending.delete(msg.id); msg.error ? pp.reject(new Error(JSON.stringify(msg.error))) : pp.resolve(msg.result); } });
  await new Promise((ok, err) => { ws.addEventListener('open', ok); ws.addEventListener('error', err); });
  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text);
    return r.result ? r.result.value : r;
  }

  console.log('=== location.hash ===');
  console.log(await evaluate('location.hash'));

  console.log('=== app.state booted/report.ready ===');
  console.log(await evaluate("(function(){var a=window.NOVEL_APP&&NOVEL_APP.state;return a?JSON.stringify({booted:a.booted,ready:a.report&&a.report.ready,error:a.report&&a.report.error}):'NO APP.state'})()"));

  console.log('=== #screen innerHTML (前 600 字) ===');
  console.log(await evaluate("(function(){var el=document.getElementById('screen');return el?el.innerHTML.slice(0,600):'NO #screen'})()"));

  console.log('=== 是否含"数据层未就绪"整屏 ===');
  console.log(await evaluate("(function(){var el=document.getElementById('screen');return el?String(el.innerHTML.indexOf('数据层未就绪')>=0):'NA'})()"));

  console.log('=== 可点击元素计数 / 首个按钮 ===');
  console.log(await evaluate("(function(){var bs=document.querySelectorAll('button,a,[data-act],.tab,.btn');var f=bs[0];return JSON.stringify({count:bs.length,first:f?(f.outerHTML||'').slice(0,120):null})})()"));

  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
