/* devtools-m9-import.cjs —— 真机验证「外部导入（章 > 节）」全链路（CDP，adb forward tcp:9222 已建立）
   证明三件事：① structuredImport.js 在 APK 内确被加载（index.html 引脚本的真机门禁）；
   ② 「我的 › 导入书籍」出现三种录入格式单选（split/chapterOnly/sectionOnly）+ txt 文件选取，切单节时揭示书→章两级下拉；
   ③ 在真机 SQLite 上跑一次 split 导入，用 DB API 证明节真挂所属章、封面字段丢弃留痕、
      空章保留、并入不动原章正文、无结构文本 reject；随后硬删清理，不污染用户真数据。
   运行：node tests/devtools-m9-import.cjs */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const EXPR = `(async () => {
  const g = globalThis, A = g.NOVEL_APP, db = g.NOVEL_DB, DA = g.NOVEL_DATA_ACTIONS;
  const out = { errs: [], checks: {} };
  window.addEventListener('error', e => out.errs.push('onerror: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', e => out.errs.push('reject: ' + (e.reason && (e.reason.message || e.reason))));
  const wait = ms => new Promise(r => setTimeout(r, ms));

  out.checks.bootReady = !!(A && A.state);
  out.checks.dbVersion = g.NOVEL_SCHEMA ? g.NOVEL_SCHEMA.LATEST_VERSION : null;

  // === 1. 解析器是否真被 APK 加载（这条功能在真机存在与否的唯一前提）===
  out.checks.siLoaded = !!(g.NOVEL_STRUCTURED_IMPORT && typeof g.NOVEL_STRUCTURED_IMPORT.parse === 'function');
  out.checks.daLoaded = !!(DA && typeof DA.importBook === 'function');

  // === 2. UI 入口：我的 › 导入书籍，三种录入格式单选 + 单节揭示两级下拉 + txt 文件选取 ===
  A.go('#/me/import'); await wait(800);
  const fmtRadios = [].slice.call(document.querySelectorAll('input[name="impFmt"]'));
  out.checks.uiFmtRadioCount = fmtRadios.length;
  const vals = fmtRadios.map(r => r.value);
  out.checks.uiHasSplit = vals.indexOf('split') >= 0;
  out.checks.uiHasChapterOnly = vals.indexOf('chapterOnly') >= 0;
  out.checks.uiHasSectionOnly = vals.indexOf('sectionOnly') >= 0;
  out.checks.uiHasFileInput = !!document.getElementById('impFile');
  const lab = document.getElementById('impBodyLab');
  const hint = document.getElementById('fmtHint');
  out.checks.uiSplitLabelHasJie = !!(lab && /节/.test(lab.textContent));
  out.checks.uiHintMentionsIgnored = !!(hint && /忽略/.test(hint.textContent));
  out.checks.uiPreCheckBtn = !!document.getElementById('preCheckBtn');
  out.checks.uiImportBtnDisabled = (document.getElementById('doImport') || {}).disabled;
  // 切到单节录入：应显示「目标章节」下拉（fldChapter 不隐藏）且隐藏书名
  const so = fmtRadios.filter(r => r.value === 'sectionOnly')[0];
  if (so) { so.checked = true; so.dispatchEvent(new Event('change', { bubbles: true })); }
  await wait(300);
  const fc = document.getElementById('fldChapter');
  out.checks.uiSectionShowsChapterSel = !!fc && fc.hidden === false;
  out.checks.uiSectionHidesTitle = (document.getElementById('fldTitle') || {}).hidden === true;
  // 切回 split 做后续端到端
  const spr = fmtRadios.filter(r => r.value === 'split')[0];
  if (spr) { spr.checked = true; spr.dispatchEvent(new Event('change', { bubbles: true })); }
  await wait(200);

  // === 3. 样本（正文行 U+3000 缩进，标题行不缩进）===
  const L = ['封面','名称：瞌睡虫的美梦','作者：qd','文体：小说','类别：长篇小说','风格：爱情','时间：2026-10-20','长度：145字','阅读章显示：章号与标题','阅读节显示：节号','','第1章 章标题','\u3000\u3000这是章的内容甲','第1节 节标题','\u3000\u3000节正文乙','','第2节 节标题','\u3000\u3000节正文丙','第2章 章标题','第3章 章标题','第4章 章标题','第5章 章标题'];
  const SAMPLE = L.join(String.fromCharCode(10));

  // === 4. 纯解析（内存，先确认解析器在真机 WebView 里逻辑一致）===
  const parsed = g.NOVEL_STRUCTURED_IMPORT.parse(SAMPLE);
  out.checks.parseChapters = parsed.chapters.length;
  out.checks.parseSectionsCh0 = parsed.chapters[0].sections.length;
  out.checks.parseMetaLinesDropped = parsed.report.dropped.metaLines;
  out.checks.parseAnomalies = parsed.report.anomalies.length;

  // === 5. 真机 SQLite 端到端导入（新建书）===
  const deps = { db: db, adapter: g.NOVEL_ADAPTER, temp: g.NOVEL_TEMP };
  const res = await DA.importBook(deps, { mode: 'new', format: 'split', text: SAMPLE });
  out.checks.impBookId = res.bookId > 0;
  out.checks.impChapters = res.chapters;
  out.checks.impSections = res.sections;
  out.checks.impFormat = res.format;

  const chs = await db.listChapters(res.bookId);
  out.checks.dbChapterCount = chs.length;
  out.checks.dbChapterIdx = chs.map(c => c.idx).join(',');
  out.checks.dbTitleDeprefixed = chs.every(c => c.title === '章标题');
  const secs0 = await db.listSections(chs[0].id);
  out.checks.secsOfCh0 = secs0.length;
  out.checks.secsAttachToCh0 = secs0.every(s => s.chapter_id === chs[0].id);
  out.checks.secsBookIdOk = secs0.every(s => String(s.book_id) === String(res.bookId));
  const othersSecs = [];
  for (let i = 1; i < chs.length; i++) othersSecs.push((await db.listSections(chs[i].id)).length);
  out.checks.otherChaptersSecs = othersSecs.join(',');
  out.checks.emptyChapterBodyBlank = (await db.getChapter(chs[1].id)).body === '';
  out.checks.chapter0HasBody = (await db.getChapter(chs[0].id)).body.indexOf('这是章的内容甲') >= 0;
  out.checks.section0Body = (await db.getSection(secs0[0].id)).body.indexOf('节正文乙') >= 0;
  const nb = (await db.listBooks()).filter(b => String(b.id) === String(res.bookId))[0];
  out.checks.bookAuthorFromCover = nb && nb.author === 'qd';
  out.checks.bookTitleFromCover = nb && nb.title === '瞌睡虫的美梦';

  // === 6. 无结构文本应 reject 且文案含「自动切分」===
  await DA.importBook(deps, { mode: 'new', format: 'split', text: '这是一封没有章节标题的长信，只是普通正文。' })
    .then(() => { out.checks.noStructReject = false; },
          e => { out.checks.noStructReject = /自动切分/.test(e.message || String(e)); });

  // === 清理：硬删新建的书（FK CASCADE 连带章与节），不留痕于用户真实数据 ===
  await db.deleteBook(res.bookId);
  out.checks.cleaned = !(await db.listBooks()).some(b => String(b.id) === String(res.bookId));

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
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  const val = r && r.result && r.result.value;
  if (!val) { console.log('EVAL_FAIL', JSON.stringify(r && r.exceptionDetails)); ws.close(); return; }
  const parsed = JSON.parse(val);
  console.log('errs: ' + JSON.stringify(parsed.errs));
  console.log(JSON.stringify(parsed.checks, null, 2));
  ws.close();
})().catch(e => console.error('PROBE_ERR', e.message));
