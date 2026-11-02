/* check-summary-live.cjs —— 验证待办5新版 UI 已上真机：点开 FAB 后动作列表含「AI摘要」。只读，不触发 AI 调用。 */
const fs = require('fs');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const ACT = `(async () => {
  const A = globalThis.NOVEL_APP; const w = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  A.go('#/section/25/12'); await w(800);
  const fab = document.querySelector('#fabWrap button') || document.querySelector('.fab');
  out.fabFound = !!fab;
  if (fab) { fab.click(); await w(400); }
  const html = document.getElementById('screen').innerHTML;
  out.hasSummaryBtn = html.indexOf('AI摘要') >= 0;
  out.actions = Array.from(document.querySelectorAll('#fabWrap button')).map(b => b.textContent.trim()).filter(t => t && t.length < 10);
  return JSON.stringify(out);
})()`;
(async () => {
  const t = await (await fetch(BASE + '/json', { signal: AbortSignal.timeout(8000) })).json();
  const p = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!p) { console.log('NO_PAGE_TARGET'); process.exitCode = 3; return; }
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let id = 0; const pm = new Map();
  const send = (m, prm) => new Promise((r, j) => { const i = ++id; pm.set(i, { res: r, rej: j }); ws.send(JSON.stringify({ id: i, method: m, params: prm || {} })); });
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pm.has(msg.id)) { const pp = pm.get(msg.id); pm.delete(msg.id); msg.error ? pp.rej(new Error(JSON.stringify(msg.error))) : pp.res(msg.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  const r = await send('Runtime.evaluate', { expression: ACT, awaitPromise: true, returnByValue: true });
  console.log(r.result && r.result.value ? r.result.value : JSON.stringify(r.exceptionDetails));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('tests/check-summary-live.png', Buffer.from(shot.data, 'base64'));
  console.log('saved tests/check-summary-live.png');
  ws.close();
})().catch(e => { console.error('ERR', e.message); process.exitCode = 2; });
