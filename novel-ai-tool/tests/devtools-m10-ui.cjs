/* devtools-m10-ui.cjs —— 优化批次真机 UI 烟测（只读，不改任何正文/不插数据）：
   进首本书第一章编辑器，核验：
   1) 顶部「查看」按钮存在且可打开速览抽屉（人物/势力两个 tab）
   2) FAB 主按钮为「工具」、无「⋯ 更多」入口
   3) FAB 含 撤销/重做/规范文本 三项 + BUILTIN 显示名带 AI 前缀
   4) 误触安全检查：只做渲染断言，不点击 AI 动作、不修改正文
   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid> */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const EXPR = `(async () => {
  var g = globalThis, A = g.NOVEL_APP, DB = g.NOVEL_DB;
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {};
  var books = await DB.listBooks();
  if (!books.length) return JSON.stringify({ skip: 'NO_BOOKS' });
  var chs = await DB.listChapters(books[0].id);
  if (!chs.length) return JSON.stringify({ skip: 'NO_CHAPTERS', book: books[0].title });
  A.go('#/chapter/' + chs[0].id);
  await wait(700);
  var body = document.body.innerHTML;
  out.route = location.hash;
  out.peekBtn = !!document.querySelector('.peekbtn');
  // 节编辑器（chapter 视图下的 #/chapter/:id 是章详情页，编辑器在 #/editor 或 #/section）
  var secs = await DB.listSections(chs[0].id);
  if (secs.length) A.go('#/section/' + chs[0].id + '/' + secs[0].id);
  else A.go('#/editor/' + books[0].id + '/' + chs[0].id);
  await wait(700);
  body = document.body.innerHTML;
  out.editRoute = location.hash;
  out.peekBtn2 = !!document.querySelector('.peekbtn');
  out.fabMain = (function () { var m = document.querySelector('.fab-main'); return m ? m.textContent.trim() : null; })();
  out.moreActGone = body.indexOf('moreAct') < 0;
  out.undoBtn = !!document.querySelector('.fab-item[data-act="undo"]');
  out.redoBtn = !!document.querySelector('.fab-item[data-act="redo"]');
  out.normBtn = !!document.querySelector('.fab-item[data-act="normalize"]');
  out.aiPrefixed = [].map.call(document.querySelectorAll('.fab-item[data-kind]'), function (b) { return b.textContent.trim(); });
  // 点开查看抽屉看速览内容再关闭（只读）
  if (out.peekBtn) {
    document.querySelector('.peekbtn').click(); await wait(250);
    var sheet = document.querySelector('#peekSheet');
    var panel = sheet && sheet.querySelector('.panel');
    out.peekSheetOpen = !!(sheet && !sheet.hidden);
    out.peekTabs = [].map.call(document.querySelectorAll('[data-peek]'), function (b) { return b.textContent.trim(); });
    out.peekItems = document.querySelectorAll('.peek-item').length;
    var closeBtn = panel && panel.querySelector('[data-closesheet]');
    if (closeBtn) closeBtn.click(); else A.go(location.hash); // 兜底：重渲当前屏收起
    await wait(200);
  }
  return JSON.stringify(out);
})()`;

(async () => {
  const targets = await (await fetch(BASE + '/json')).json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET'); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pend.has(msg.id)) { const p = pend.get(msg.id); pend.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  console.log(r && r.result && r.result.value || 'EVAL_FAIL ' + JSON.stringify(r));
  ws.close();
})().catch(e => console.error('PROBE_ERR', e.message));
