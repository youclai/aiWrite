/* devtools-m7c-probe.cjs —— 捕获“新建作品”按钮点击时是否抛错（sheetForm 是否真能开出弹层）。 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const EXPR = `(async () => {
  const g = globalThis, A = g.NOVEL_APP; const errs = [];
  window.addEventListener('error', e => errs.push('onerror: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', e => errs.push('reject: ' + (e.reason && (e.reason.message || e.reason))));
  A.go('#/shelf'); await new Promise(r=>setTimeout(r,300));
  const btn = document.querySelector('#newBook');
  let clickThrew = '';
  try { if (btn) btn.click(); } catch (e) { clickThrew = e.message; }
  await new Promise(r=>setTimeout(r,300));
  const fs = document.querySelector('#formSheet');
  const screenHTML = A.el ? A.el.outerHTML.slice(0, 200) : '';
  return JSON.stringify({ btnFound: !!btn, clickThrew, errs, fsExists: !!fs, fsHidden: fs ? fs.hidden : null,
    fsInput: fs ? !!fs.querySelector('input') : null, hasFormSheetStr: /formSheet/.test(screenHTML) });
})()`;
async function main() {
  const targets = await (await fetch(BASE + '/json')).json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET'); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.addEventListener('message', ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const pp = pending.get(msg.id); pending.delete(msg.id); msg.error ? pp.rej(new Error(JSON.stringify(msg.error))) : pp.res(msg.result); } });
  await new Promise(r => ws.addEventListener('open', r));
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
  console.log((r && r.result && r.result.value) || JSON.stringify(r));
  ws.close();
}
main().catch(e => { console.log('PROBE_FAIL: ' + e.message); process.exitCode = 1; });
