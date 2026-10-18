/* devtools-m7-probe.cjs —— M7 UI 重构真机自检：boot 就绪、底部两页签、#/me 竖tab、
   #/book/:id 竖tab(章节/人物/剧情/势力/信息)、schema v3 factions 可用、路由渲染无崩。
   连 WebView DevTools（先 adb forward tcp:9222 ...），Runtime.evaluate 跑一段页内脚本。
   运行：node tests/devtools-m7-probe.cjs   （需已 force-stop+启动 App、pidof+forward 设好）*/
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const EXPR = `(async () => {
  const g = globalThis, A = g.NOVEL_APP, out = { report:null, tabCount:0, hash:location.hash, books:-1, factionsAPI:false, steps:[] };
  try { out.report = { ready:g.NOVEL_BOOT.report.ready, fts:g.NOVEL_DB.info().ftsMode, ver:g.NOVEL_DB.info().toVersion, secure:g.NOVEL_BOOT.report.secure && g.NOVEL_BOOT.report.secure.status, temp:g.NOVEL_BOOT.report.temp && g.NOVEL_BOOT.report.temp.status }; } catch(e){ out.report='ERR '+e.message; }
  try { const bs = await g.NOVEL_DB.listBooks(); out.books = bs.length; out.firstBookId = bs[0] ? bs[0].id : null; } catch(e){ out.steps.push({hash:'listBooks', ERR:e.message}); }
  out.factionsAPI = typeof g.NOVEL_DB.listFactions === 'function';
  try { const f = await g.NOVEL_DB.listFactions(out.firstBookId||0); out.factionsQueryOK = Array.isArray(f); } catch(e){ out.factionsQueryOK = 'ERR '+e.message; }
  out.tabCount = document.querySelectorAll('.tabbar .tab').length;
  async function nav(h){
    try {
      A.go(h);
      await new Promise(r=>setTimeout(r,300));
      const el = A.el, er = el && el.querySelector ? el.querySelector('.err') : null;
      out.steps.push({ hash:h, len: el?el.innerHTML.length:-1, booting: el?/加载中/.test(el.textContent):null, err: er?er.textContent.slice(0,50):'' });
    } catch(e){ out.steps.push({ hash:h, ERR:e.message }); }
  }
  await nav('#/shelf'); await nav('#/me'); await nav('#/me/ai');
  await nav('#/me/storage'); await nav('#/me/appearance'); await nav('#/me/data');
  if (out.firstBookId != null) {
    const id = out.firstBookId;
    await nav('#/book/'+id+'/chapters'); await nav('#/book/'+id+'/chars');
    await nav('#/book/'+id+'/plot'); await nav('#/book/'+id+'/faction'); await nav('#/book/'+id+'/info');
  }
  return JSON.stringify(out);
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
  const val = r && r.result && r.result.value;
  console.log(val || JSON.stringify(r));
  ws.close();
}
main().catch(e => { console.log('PROBE_FAIL: ' + e.message); process.exitCode = 1; });
