/* devtools-m7d-probe.cjs —— 复现用户"点击左侧 5 个功能块没效果"：
   真机 WebView 里【模拟点击】book 详情中的 5 个 vbtn 与书架的 #newBook 按钮，
   观察 hash 是否变化、#bookBody/#meBody 内容是否刷新、active 类是否切换、有无错。
   运行：node tests/devtools-m7d-probe.cjs  （需已 force-stop+启动 App、pidof+forward 设好）*/
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const EXPR = `(async () => {
  const g = globalThis, A = g.NOVEL_APP, out = { steps: [], errs: [], hash: location.hash, bookId: null };
  window.addEventListener('error', e => out.errs.push('onerror: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', e => out.errs.push('reject: ' + (e.reason && (e.reason.message || e.reason))));

  async function snap(name) {
    const bodyEl = document.querySelector('#bookBody') || document.querySelector('#meBody');
    const active = document.querySelector('.vbtn.active');
    out.steps.push({
      name, hash: location.hash,
      bodyLen: bodyEl ? bodyEl.innerHTML.length : -1,
      bodyHead: bodyEl ? (bodyEl.textContent || '').replace(/\\s+/g,' ').slice(0, 40) : '',
      activeTab: active ? active.textContent : null,
      vbtnCount: document.querySelectorAll('.vbtn').length,
      err: (document.querySelector('.err') || {}).textContent || ''
    });
  }
  function clickAndWait(el, ms) {
    return new Promise(r => { if (!el) return r('NO_EL'); el.click(); setTimeout(()=>r('OK'), ms||350); });
  }

  // 1) 书架 → 真点 #newBook（此前 ensureSheet 返回 null bug 影响这里）
  A.go('#/shelf'); await new Promise(r=>setTimeout(r,300));
  const nb = document.querySelector('#newBook');
  out.newBookBtn = !!nb;
  await clickAndWait(nb, 300);
  const fs = document.querySelector('#formSheet');
  out.formSheetVisible = fs ? !fs.hidden : 'NO_SHEET_EL';
  out.formSheetHasInput = fs ? !!fs.querySelector('input') : false;
  // 关掉弹层，不写入业务数据
  if (fs && !fs.hidden) { const c = fs.querySelector('[data-closesheet]'); if (c) c.click(); }
  await new Promise(r=>setTimeout(r,150));

  // 2) 进入第一本书 → 应看到 5 个左 nav
  const bs = await g.NOVEL_DB.listBooks();
  if (!bs.length) { out.noBook = true; return JSON.stringify(out); }
  out.bookId = bs[0].id;
  A.go('#/book/' + out.bookId); await new Promise(r=>setTimeout(r,350));
  await snap('enterBookDefault');

  // 3) 依次真点 5 个 vbtn（不是走 A.go）
  const navs = document.querySelectorAll('.vnav [data-tab-nav]');
  out.vnavFound = navs.length;
  for (let i = 0; i < navs.length; i++) {
    const label = navs[i].textContent;
    await clickAndWait(navs[i], 400);
    await snap('clickVbtn#' + i + ':' + label);
  }

  // 4) 我的 → 4 个 vbtn
  A.go('#/me'); await new Promise(r=>setTimeout(r,350));
  await snap('enterMeDefault');
  const meNavs = document.querySelectorAll('.vnav [data-me-nav]');
  out.meVnavFound = meNavs.length;
  for (let i = 0; i < meNavs.length; i++) {
    const label = meNavs[i].textContent;
    await clickAndWait(meNavs[i], 400);
    await snap('clickMeVbtn#' + i + ':' + label);
  }

  return JSON.stringify(out, null, 2);
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
