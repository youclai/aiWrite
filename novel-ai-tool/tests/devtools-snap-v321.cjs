/* devtools-snap-v321.cjs —— 抓"配置 AI 助手"：Model 改为下拉，选 DeepSeek 自动带入地址并在模型清单选中 deepseek-chat */
const fs = require('fs');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const ACT = `(async () => {
  const A = globalThis.NOVEL_APP; const wait = ms => new Promise(r => setTimeout(r, ms));
  A.go('#/me'); await wait(700);
  const s = document.querySelector('#prov'); s.value = 'deepseek'; s.dispatchEvent(new Event('change'));
  await wait(150); return 'ok';
})()`;
(async () => {
  const t = await (await fetch(BASE + '/json')).json();
  const p = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!p) { console.log('NO_PAGE'); return; }
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let id = 0; const pm = new Map();
  const send = (m, prm) => new Promise((r, j) => { const i = ++id; pm.set(i, { res: r, rej: j }); ws.send(JSON.stringify({ id: i, method: m, params: prm || {} })); });
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pm.has(msg.id)) { const pp = pm.get(msg.id); pm.delete(msg.id); msg.error ? pp.rej(new Error(JSON.stringify(msg.error))) : pp.res(msg.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.evaluate', { expression: ACT, awaitPromise: true, returnByValue: true });
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('tests/v321-model-dropdown.png', Buffer.from(s.data, 'base64'));
  console.log('saved tests/v321-model-dropdown.png');
  ws.close();
})().catch(e => console.error('SNAP_ERR', e.message));
