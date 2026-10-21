/* devtools-import-ch1.cjs —— 用 CDP 驱动“外部导入”界面，把「第一章 童年的那顿饭」的三节
   作为“一章挂三节”并入设备上的《勇者》一书。全程走 App 真实界面链路
   （#/me/import → 选并入/目标书/split → 填正文 → 预检 → 确认 → importBook），不直接写库。
   组包：文件1 全文（含“第一章”标题+第一节），文件2/3 去掉各自重复的“第一章”首行，只留“第N节”起。
   用法：
     node tests/devtools-import-ch1.cjs preflight   # 只列书+定位勇者+现有章，不写库
     node tests/devtools-import-ch1.cjs doit         # 真正执行并入导入
   前置：App 已打开，adb forward tcp:9222 到 webview_devtools_remote 已建立。 */
const fs = require('fs');
const path = require('path');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const MODE = process.argv[2] || 'preflight';
const DIR = 'd:/xh/C-新书/C-第01章-童年的那顿饭';
const FILES = [
  'C-第01章-第01节-晚饭是从烟囱开始的.txt',
  'C-第01章-第02节-东西是村长分的.txt',
  'C-第01章-第03节-孩子进教堂.txt'
];

// 去 BOM / 统一换行 / 去行尾空白；保留段间空行（正文段落靠空行分隔）
function loadCsv(name) {
  return fs.readFileSync(path.join(DIR, name), 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
}

// 组包：文件1 全量；文件2/3 丢弃首个“第N章”标题行（避免解析成多章），从“第N节”行起并入
function buildText() {
  const parts = [];
  const a = loadCsv(FILES[0]);
  parts.push(a.join('\n'));
  for (let i = 1; i < FILES.length; i++) {
    const lines = loadCsv(FILES[i]);
    // 找第一个“第..节”标题行；它之前若全是“第..章”标题/空行则丢弃
    let k = 0;
    while (k < lines.length && !/^第\s*[0-9〇零一二三四五六七八九十百千万两]+\s*节/.test(lines[k])) k++;
    parts.push(lines.slice(k).join('\n'));
  }
  // 各段之间用一个空行衔接，去掉可能的 3+ 连续空行
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const TEXT = buildText();

const EXPR = `(async () => {
  const g = globalThis, DB = g.NOVEL_DB, A = g.NOVEL_APP;
  const NL = String.fromCharCode(10);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const importText = ${JSON.stringify(TEXT)};
  const out = { mode: ${JSON.stringify(MODE)}, textLen: importText.length };

  // 定位《勇者》
  const books = await DB.listBooks();
  out.books = books.map(b => ({ id: b.id, title: b.title }));
  const target = books.find(b => String(b.title || '').trim() === '勇者')
    || books.find(b => String(b.title || '').indexOf('勇者') >= 0);
  if (!target) { out.error = 'BOOK_NOT_FOUND'; return JSON.stringify(out); }
  out.bookId = target.id; out.bookTitle = target.title;

  const before = await DB.listChapters(target.id);
  out.beforeCount = before.length;
  out.beforeTitles = before.map(c => ({ idx: c.idx, title: c.title }));

  // 结构预演（用页面里已加载的解析器，确认组包 = 1 章 3 节，且字数合理）——不写库
  const parsed = g.NOVEL_STRUCTURED_IMPORT.parse(importText);
  out.parseChapters = parsed.report.stats.chapters;
  out.parseSections = parsed.report.stats.sections;
  out.parseWords = parsed.report.stats.words;
  out.parseTree = parsed.chapters.map(c => ({
    title: c.title,
    sections: c.sections.map(s => ({ title: s.title, words: g.NOVEL_STRUCTURED_IMPORT.countNonSpace(s.body) }))
  }));

  if (${JSON.stringify(MODE)} !== 'doit') return JSON.stringify(out);

  // ---- 走真实界面：路由 → 并入 → 选目标书 → 填正文 → 预检 → 确认 ----
  A.go('#/me/import'); await wait(800);
  const q = s => document.querySelector(s);
  const mergeR = q('input[name="impMode"][value="merge"]');
  if (!mergeR || mergeR.disabled) { out.error = 'MERGE_UNAVAILABLE'; return JSON.stringify(out); }
  mergeR.checked = true; mergeR.dispatchEvent(new Event('change')); await wait(300);
  // 格式默认 split（章节分开录入），确保选中
  const splitR = q('input[name="impFmt"][value="split"]');
  if (splitR && !splitR.checked) { splitR.checked = true; splitR.dispatchEvent(new Event('change')); await wait(200); }
  const sel = q('#impBook'); sel.value = String(target.id); sel.dispatchEvent(new Event('change')); await wait(400);
  const bodyEl = q('#impBody'); bodyEl.value = importText; bodyEl.dispatchEvent(new Event('input')); await wait(150);

  q('#preCheckBtn').click();
  let sheet;
  for (let i = 0; i < 20; i++) {
    await wait(300);
    sheet = [].filter.call(document.querySelectorAll('.sheet'), s => !s.hidden && /导入预检/.test(s.textContent))[0];
    if (sheet) break;
  }
  if (!sheet) { out.error = 'NO_PRECHECK_SHEET'; return JSON.stringify(out); }
  out.precheckText = sheet.textContent.replace(/\\s+/g, ' ').slice(0, 200);
  out.doImportEnabled = !q('#doImport').disabled;

  const ok = sheet.querySelector('[data-icok]');
  ok.click();
  // 等导航离开导入页（doImport 成功后 go 到书章节页）
  for (let j = 0; j < 30; j++) { await wait(300); if (/#\\/book\\//.test(location.hash)) break; }
  out.hashAfter = location.hash;

  const after = await DB.listChapters(target.id);
  out.afterCount = after.length;
  out.appended = after.slice(before.length).map(c => ({ idx: c.idx, title: c.title }));
  out.originalKept = before.every((b, i) => after[i] && after[i].id === b.id && after[i].title === b.title);
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
  console.log('page: ' + page.url);
  console.log(JSON.stringify(JSON.parse(val), null, 2));
  const parsed = JSON.parse(val);
  if (parsed.error) { console.log('RESULT_ERROR=' + parsed.error); process.exitCode = 5; }
  else if (MODE === 'doit') { console.log('IMPORT_DONE appended=' + (parsed.appended ? parsed.appended.length : 0) + ' originalKept=' + parsed.originalKept); }
  ws.close();
})().catch(e => { console.error('PROBE_ERR', e.message); process.exitCode = 2; });
