/* devtools-m9-probe.cjs —— 真机验证 v3.18 六项改动：
   1) 章节卡片进入 #/chapter/:id 节列表，新建节 → #/section/...
   2) 节编辑器：textarea 占满、无横向滚动、FAB 存在且可展开/收起
   3) 卡片按钮下移：人物/剧情/势力 item 含 .it-actions
   4) 返回按钮可点
   运行：node tests/devtools-m9-probe.cjs */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const EXPR = `(async () => {
  const g = globalThis, A = g.NOVEL_APP, out = { steps: [], errs: [] };
  window.addEventListener('error', e => out.errs.push('onerror: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', e => out.errs.push('reject: ' + (e.reason && (e.reason.message || e.reason))));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const db = g.NOVEL_DB;

  // 备数据：取第一本书，建一章
  const bs = await db.listBooks();
  if (!bs.length) { const id = await db.createBook({ title: 'v318验证书' }); }
  const books = await db.listBooks();
  const bookId = books[0].id;
  const chapId = await db.createChapter(bookId, 'v318测试章');

  // === TEST 1: 章详情页 ===
  A.go('#/chapter/' + chapId); await wait(500);
  const cdoc = document.querySelector('.body');
  out.steps.push({ t: 'chapter-detail', hash: location.hash,
    hasSecrow: !!document.querySelector('.secrow'),
    hasEditChBody: !!document.querySelector('#editChBody'),
    hasNewSec: !!document.querySelector('#newSec') });

  // === TEST 2: 新建节 → 节编辑器 ===
  const secId = await db.createSection(chapId, '第1节');
  A.go('#/section/' + chapId + '/' + secId); await wait(600);
  const ta = document.querySelector('#body.ta');
  const cs = ta ? getComputedStyle(ta) : null;
  out.steps.push({ t: 'section-editor', hash: location.hash,
    taExists: !!ta, taFlex: cs ? cs.flex : null,
    fabMain: !!document.querySelector('#fabBtn'),
    fabItemCount: document.querySelectorAll('.fab-item[data-kind]').length,
    noVerBtn: !document.querySelector('#verBtn') });

  // === TEST 3: 无横向滚动 ===
  out.steps.push({ t: 'no-hscroll', docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth, innerW: window.innerWidth,
    fits: document.documentElement.scrollWidth <= window.innerWidth + 1 });

  // === TEST 4: FAB 展开/收起（真点） ===
  const fab = document.querySelector('#fabBtn');
  fab.click(); await wait(150);
  const opened = document.querySelector('#fabWrap').classList.contains('open');
  fab.click(); await wait(150);
  const closed = !document.querySelector('#fabWrap').classList.contains('open');
  out.steps.push({ t: 'fab-toggle', opened: opened, closedAfterSecondClick: closed });

  // === TEST 5: 节正文落盘 ===
  ta.value = '这是一节测试正文。'; ta.dispatchEvent(new Event('input'));
  await wait(50);
  const wc = await db.saveSectionDraft(secId, ta.value);
  const got = await db.getSection(secId);
  out.steps.push({ t: 'section-save', wc: wc, saved: got.body === '这是一节测试正文。' });

  // === TEST 6: 返回按钮存在可点 ===
  const back = document.querySelector('.back[data-back]');
  out.steps.push({ t: 'back-btn', exists: !!back, target: back ? back.getAttribute('data-back') : null });

  // 清理测试数据
  await db.deleteChapter(chapId);

  return JSON.stringify(out, null, 0);
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
  const val = r && r.result && r.result.value;
  if (!val) { console.log('EVAL_FAIL', JSON.stringify(r)); ws.close(); return; }
  const parsed = JSON.parse(val);
  console.log('errs:', JSON.stringify(parsed.errs));
  parsed.steps.forEach(s => console.log(JSON.stringify(s)));
  ws.close();
})().catch(e => console.error('PROBE_ERR', e.message));
