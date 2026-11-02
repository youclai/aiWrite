/* check-section-body.cjs —— 进入有正文的节（勇者书 ch25 sec12），校验编辑器正文与 DB 一致。只读。 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const ACT = `(async () => {
  const A = globalThis.NOVEL_APP; const DB = globalThis.NOVEL_DB;
  const w = ms => new Promise(r => setTimeout(r, ms));
  A.go('#/chapter/25'); await w(500);
  const chapterHash = location.hash;
  A.go('#/section/25/12'); await w(900);
  const ta = document.querySelector('#body');
  const secs = await DB.listSections(25);
  const s = secs.find(x => String(x.id) === '12');
  const dbBody = s && typeof s.body === 'string' ? s.body : null;
  return JSON.stringify({
    chapterHash, secHash: location.hash,
    taLen: ta ? ta.value.length : -1,
    dbBodyLen: dbBody !== null ? dbBody.length : ('body 未随行, body_len=' + (s ? s.body_len : 'no sec')),
    match: dbBody !== null && ta ? ta.value === dbBody : 'n/a',
    wcUI: (document.querySelector('#wc') || {}).textContent,
    title: (document.querySelector('#chTitle') || {}).value,
    head20: ta ? ta.value.slice(0, 20) : ''
  });
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
  ws.close();
})().catch(e => { console.error('ERR', e.message); process.exitCode = 2; });
