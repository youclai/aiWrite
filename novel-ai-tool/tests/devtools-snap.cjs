/* devtools-snap.cjs —— 走 DevTools Page.captureScreenshot 抓两张真机屏（章节/人物）。*/
const fs = require('fs');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const shots = [
  { hash: '#/book/2/chapters', file: 'tests/snap-chapters.png' },
  { hash: '#/book/2/chars',    file: 'tests/snap-chars.png' },
  { hash: '#/book/2/faction',  file: 'tests/snap-faction.png' },
];
(async () => {
  const t = await (await fetch(BASE + '/json')).json();
  const p = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!p) { console.log('NO_PAGE'); return; }
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let id = 0; const pm = new Map();
  const send = (m, prm) => new Promise((r, j) => { const i = ++id; pm.set(i, { res: r, rej: j }); ws.send(JSON.stringify({ id: i, method: m, params: prm || {} })); });
  ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pm.has(msg.id)) { const pp = pm.get(msg.id); pm.delete(msg.id); msg.error ? pp.rej(new Error(JSON.stringify(msg.error))) : pp.res(msg.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  for (const s of shots) {
    await send('Runtime.evaluate', { expression: 'globalThis.NOVEL_APP.go(' + JSON.stringify(s.hash) + ");'ok'" });
    await new Promise(r => setTimeout(r, 500));
    const sc = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(s.file, Buffer.from(sc.data, 'base64'));
    console.log('SNAP ' + s.file + ' ' + fs.statSync(s.file).size + 'B');
  }
  ws.close();
})().catch(e => { console.log('ERR ' + e.message); process.exitCode = 1; });
