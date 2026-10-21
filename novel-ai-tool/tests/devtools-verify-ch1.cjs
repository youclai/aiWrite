/* devtools-verify-ch1.cjs —— 只读校验：《勇者》首章「童年的那顿饭」下三节是否带正文落库。 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const EXPR = `(async () => {
  const DB = globalThis.NOVEL_DB;
  const chs = await DB.listChapters(5);
  const ch = chs.find(c => (c.title || '').indexOf('童年的那顿饭') >= 0) || chs[chs.length - 1];
  if (!ch) return JSON.stringify({ error: 'NO_CHAPTER' });
  const secs = await DB.listSections(ch.id);
  const head = s => String(s || '').replace(/\\s+/g, '').slice(0, 16);
  const full = [];
  for (const s of secs) { const f = await DB.getSection(s.id); full.push(f); }
  return JSON.stringify({
    chapterId: ch.id, chapterTitle: ch.title,
    sectionCount: secs.length,
    sections: full.map(s => ({ title: s.title, words: s.word_count, bodyLen: String(s.body || '').length, head: head(s.body), tail: head(String(s.body || '').slice(-30)) }))
  });
})()`;
(async () => {
  const targets = await (await fetch(BASE + '/json')).json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET'); process.exitCode = 3; return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pend.has(msg.id)) { const p = pend.get(msg.id); pend.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(JSON.parse(r.result.value), null, 2));
  ws.close();
})().catch(e => { console.error('PROBE_ERR', e.message); process.exitCode = 2; });
