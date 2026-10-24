/* 点开 FAB 工具菜单（供截图） */
const BASE = 'http://127.0.0.1:9222';
(async () => {
  const t = await (await fetch(BASE + '/json')).json();
  const p = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let i = 0; const m = new Map();
  const send = (mm, pp) => new Promise((r, j) => { const k = ++i; m.set(k, { r, j }); ws.send(JSON.stringify({ id: k, method: mm, params: pp || {} })); });
  ws.onmessage = e => { const g = JSON.parse(e.data); if (g.id && m.has(g.id)) { const c = m.get(g.id); m.delete(g.id); g.error ? c.j(new Error(JSON.stringify(g.error))) : c.r(g.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  const r = await send('Runtime.evaluate', { expression: 'document.querySelector(".fab-main").click(); "clicked"', returnByValue: true });
  console.log(JSON.stringify(r && r.result && r.result.value));
  await new Promise(r2 => setTimeout(r2, 500));
  ws.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
