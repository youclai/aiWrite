/* probe-state.cjs —— 只读探查设备 App 当前数据：书 / 章 / 节 / 人物 / 势力，不写库。
   用法：node tests/probe-state.cjs  [书名关键字，默认"勇者"]
   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid> 已建立。 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const KW = process.argv[2] || '勇者';

const EXPR = `(async () => {
  const DB = globalThis.NOVEL_DB;
  const out = {};
  const books = await DB.listBooks();
  out.books = books.map(b => ({ id: b.id, title: b.title }));
  const target = books.find(b => String(b.title || '').indexOf(${JSON.stringify(KW)}) >= 0);
  if (!target) { out.error = 'BOOK_NOT_FOUND'; return JSON.stringify(out); }
  out.bookId = target.id; out.bookTitle = target.title;
  const chapters = await DB.listChapters(target.id);
  out.chapters = [];
  for (const c of chapters) {
    const secs = await DB.listSections(c.id);
    out.chapters.push({
      id: c.id, idx: c.idx, title: c.title,
      sections: secs.map(s => ({ id: s.id, idx: s.idx, title: s.title, bodyLen: s.body_len, words: s.word_count }))
    });
  }
  out.characters = (await DB.listCharacters(target.id)).map(x => ({ id: x.id, name: x.name, role: x.role }));
  out.factions = (await DB.listFactions(target.id)).map(x => ({ id: x.id, name: x.name, kind: x.kind }));
  return JSON.stringify(out);
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
  const val = r && r.result && r.result.value;
  if (!val) { console.log('EVAL_FAIL', JSON.stringify(r && r.exceptionDetails)); ws.close(); process.exitCode = 4; return; }
  console.log(JSON.stringify(JSON.parse(val), null, 2));
  ws.close();
})().catch(e => { console.error('PROBE_ERR', e.message); process.exitCode = 2; });
