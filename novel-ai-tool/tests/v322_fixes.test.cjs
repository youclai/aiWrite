/* v322_fixes.test.cjs —— 真机走查 8 条修改建议（v3.22 批次）电脑侧自验：
 *  ① prompt.build userHint：不传=与旧输出一致；传=拼进[指令]；超预算不被裁剪；>500 字截断
 *  ② session.executeAction 透传 userHint 到最终 prompt
 *  ③ dataActions.importBook 并入模式：不建新书、idx 追加在末尾、原章正文不变、
 *     空/不存在 bookId 可读报错、中途失败带 imported/total；mode:'new' 回归不破坏
 *  ④ app.js 统一回退：navigateUp 逐级映射 / 非顶层不弹退出 / 覆盖层优先关闭 / 顶层双击退出
 * 运行：node tests/v322_fixes.test.cjs */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const sc = f => fs.readFileSync(path.join(ROOT, 'www/js', f), 'utf8');
const out = [];
let pass = 0, fail = 0;
const log = (...a) => out.push(a.join(' '));
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; log(`  PASS ${name}`); }
  else { fail++; log(`  FAIL ${name}\n       got : ${g}\n       want: ${w}`); }
};
const ok = (name, cond, hint) => eq(name, !!cond, true, hint);
const G = globalThis;

function makeAdapter() {
  const d = new DatabaseSync(':memory:');
  return {
    db: d,
    all: (sql, params) => d.prepare(sql).all(...(params || [])),
    run: (sql, params) => { const r = d.prepare(sql).run(...(params || [])); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; },
    exec: (sql) => d.exec(sql),
    close: () => d.close()
  };
}
function makeNodeFs(rootDir) {
  const abs = rel => path.join(rootDir, rel);
  return {
    ensureDir: rel => { fs.mkdirSync(abs(rel), { recursive: true }); return true; },
    writeFile: (rel, content) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), content, 'utf8'); },
    writeBytes: (rel, u8) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), Buffer.from(u8)); },
    readFile: rel => fs.readFileSync(abs(rel), 'utf8'),
    readBytes: rel => new Uint8Array(fs.readFileSync(abs(rel))),
    exists: rel => fs.existsSync(abs(rel)),
    readdir: rel => fs.readdirSync(abs(rel), { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() })),
    deleteFile: rel => { fs.rmSync(abs(rel), { force: true }); },
    removeDir: rel => { fs.rmSync(abs(rel), { recursive: true, force: true }); },
    stat: rel => ({ size: fs.statSync(abs(rel)).size })
  };
}

(async () => {
  log('v3.22 修改建议落地自验  ' + new Date().toISOString());
  log('');

  /* ================= ① prompt.build userHint ================= */
  log('== prompt.build · userHint ==');
  ['schema.js', 'util.js', 'prompt.js'].forEach(f => new Function(sc(f))(G));
  const P = G.NOVEL_PROMPT;
  const base = {
    book: { synopsis: '简介一二三', style_note: '冷硬' },
    chapterSummary: '本章摘要内容',
    selection: '他推门而入。', beforeText: '前文段落A\n\n前文段落B', afterText: '后文段落C\n\n后文段落D',
    matchText: '他推门而入。', characters: [], template: { name: '润色', instruction: '润色下文。' },
    settings: { use_summary: true, inject_taboos: true, token_budget: 6000 }
  };
  const noHint = P.build(base);
  ok('不传 userHint 输出无补充字样', noHint.prompt.indexOf('用户的补充要求') < 0);
  const withHint = P.build(Object.assign({}, base, { userHint: '更口语化，别改人名' }));
  ok('指令段含补充要求', /\[指令\][\s\S]*用户的补充要求：更口语化，别改人名/.test(withHint.prompt));
  ok('指令段保留原指令', withHint.prompt.indexOf('润色下文。') >= 0);
  // 超预算：只留选段+指令（含 userHint），其它层被裁但补充要求仍在
  const tight = P.build(Object.assign({}, base, {
    userHint: '补充要求必须活下来', characters: [{ name: '林九', personality: '多疑' }],
    settings: { use_summary: true, inject_taboos: true, token_budget: 20 }
  }));
  ok('超预算仍含 userHint', tight.prompt.indexOf('补充要求必须活下来') >= 0);
  ok('超预算仍含选段', tight.prompt.indexOf('他推门而入。') >= 0);
  ok('超预算锁定标记', tight.locked === true && tight.trimmed.length > 0);
  // 500 字上限截断
  const longHint = P.build(Object.assign({}, base, { userHint: 'a'.repeat(600) }));
  ok('userHint 截断至 500', /a{500}(?!a)/.test(longHint.prompt) && !/a{501}/.test(longHint.prompt));

  /* ================= ② session 透传 ================= */
  log('== session.executeAction · userHint 透传 ==');
  ['clean.js', 'providers.js', 'db.js', 'session.js'].forEach(f => { try { new Function(sc(f))(G); } catch (e) { /* db.js 可能已载 */ } });
  const DB = G.NOVEL_DB;
  const ad = makeAdapter();
  await DB.init(ad);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v322-'));
  new Function(sc('tempStore.js'))(G); new Function(sc('zip.js'))(G);
  new Function(sc('exporter.js'))(G); new Function(sc('importer.js'))(G);
  new Function(sc('zipper.js'))(G); new Function(sc('docx.js'))(G);
  new Function(sc('backup.js'))(G); new Function(sc('storage.js'))(G);
  new Function(sc('dataActions.js'))(G);
  await G.NOVEL_TEMP.init(makeNodeFs(tmpRoot));
  let capturedPrompt = '';
  const deps = {
    db: DB, prompt: P,
    providers: { describe: () => ({ id: 'mock' }), errorReason: e => String(e) },
    stream: { run: o => { capturedPrompt = o.prompt; o.onDone('结果'); return { cancel() {}, text: () => '' }; } },
    clean: G.NOVEL_CLEAN, secure: { getSecret: () => Promise.resolve('') }
  };
  const bookId = await DB.createBook({ title: '会话书' });
  const cid = await DB.createChapter(bookId, '第一章');
  await DB.saveChapterBody(cid, '正文他推门而入。', 'adopt');
  const ch = await DB.getChapter(cid);
  const sres = await G.NOVEL_SESSION.executeAction(deps, {
    book: { id: bookId, synopsis: '' }, chapter: ch, characters: [], settings: {}, api: { provider: 'mock' },
    template: { kind: 'polish', name: '润色', instruction: '润色下文。' },
    userHint: '补环境细节', selection: { start: 0, end: 2, text: '正文' }, before: '', after: ''
  });
  ok('session 执行成功', sres.ok === true);
  ok('发往模型的 prompt 含补充要求', capturedPrompt.indexOf('用户的补充要求：补环境细节') >= 0);

  /* ================= ③ importBook merge 模式 ================= */
  log('== dataActions.importBook · 并入模式 ==');
  const DA = G.NOVEL_DATA_ACTIONS;
  const iDeps = { db: DB, adapter: ad, temp: G.NOVEL_TEMP };
  // 先造一本有 2 章且正文已定的书
  const mBook = await DB.createBook({ title: '目标书' });
  const c1 = await DB.createChapter(mBook, '第一章 旧');
  const c2 = await DB.createChapter(mBook, '第二章 旧');
  await DB.saveChapterBody(c1, '不可动的原文甲', 'adopt');
  await DB.saveChapterBody(c2, '不可动的原文乙', 'adopt');
  const booksBefore = (await DB.listBooks()).length;
  const mres = await DA.importBook(iDeps, {
    mode: 'merge', bookId: mBook,
    text: '第一章 旧\n新内容一\n\n第三章 新\n新内容二\n\n第四章 新\n新内容三'
  });
  eq('merge 返回 appended=3', mres.appended, 3);
  eq('merge 返回 chapters=3', mres.chapters, 3);
  eq('merge 不建新书', (await DB.listBooks()).length, booksBefore);
  eq('merge 模式回显', mres.mode, 'merge');
  eq('merge bookId 指向原书', String(mres.bookId), String(mBook));
  const after = await DB.listChapters(mBook);
  eq('章节数 2→5', after.length, 5);
  eq('idx 追加在末尾', after.map(c => c.idx).join(','), '1,2,3,4,5');
  const old1 = await DB.getChapter(c1);
  const old2 = await DB.getChapter(c2);
  ok('原章正文不变（含重名标题章）', old1.body === '不可动的原文甲' && old2.body === '不可动的原文乙');
  const appendedFirst = await DB.getChapter(after[2].id);
  ok('追加章正文正确', appendedFirst.body.indexOf('新内容一') >= 0);
  // 校验与失败路径
  await DA.importBook(iDeps, { mode: 'merge', bookId: '', text: '第一章 甲\n文' }).then(
    () => ok('空 bookId 应 reject', false),
    e => ok('空 bookId 可读报错', /目标书籍/.test(e.message), e.message));
  await DA.importBook(iDeps, { mode: 'merge', bookId: 99999, text: '第一章 甲\n文' }).then(
    () => ok('不存在 bookId 应 reject', false),
    e => ok('不存在 bookId 可读报错', /不存在/.test(e.message), e.message));
  // 中途失败：让第 2 章正文保存抛错 → imported=1/total=2
  const realSave = DB.saveChapterBody;
  let boomN = 0;
  DB.saveChapterBody = function (id, body, reason) {
    boomN++;
    if (boomN === 2) return Promise.reject(new Error('模拟断电'));
    return realSave.call(DB, id, body, reason);
  };
  await DA.importBook(iDeps, { mode: 'merge', bookId: mBook, text: '第十章 甲\n内容A\n\n第十一章 乙\n内容B' }).then(
    () => ok('中途失败应 reject', false),
    e => { ok('失败带原因', /模拟断电/.test(e.message)); eq('失败带进度 imported', e.imported, 1); eq('失败带进度 total', e.total, 2); });
  DB.saveChapterBody = realSave;
  // new 模式回归
  const nres = await DA.importBook(iDeps, { title: '新书', text: '第一章 起\n内容一\n\n第二章 承\n内容二' });
  eq('new 模式仍建新书 2 章', nres.chapters, 2);
  eq('new 模式回显 mode', nres.mode, 'new');
  ok('new 模式书数 +1', (await DB.listBooks()).length === booksBefore + 1);

  /* ================= ④ app.js 统一回退 ================= */
  log('== app.js · navigateUp / onBack 逐级回退 ==');
  // 环境桩：app.js 末尾用裸 document（与 m4_router 同法），挂到真 globalThis 上；可控 location.hash
  const HG = G;
  HG.document = HG.document || { addEventListener: function () {} };
  const loc = { _h: '#/shelf', get hash() { return this._h; }, set hash(v) { this._h = v; } };
  HG.location = loc;
  HG.addEventListener = function () {};
  HG.Capacitor = undefined;
  new Function(sc('util.js'))(HG);
  new Function(sc('app.js'))(HG);
  const A = HG.NOVEL_APP;
  let exitCalled = 0, toasts = [];
  A.nativeExit = function () { exitCalled++; };
  A.toast = function (m) { toasts.push(m); };

  function backFrom(hash, bookIdState) {
    loc._h = hash; A.state.bookId = bookIdState || null; A.state.flush = null;
    toasts = []; A._lastBack = 0;
    A.onBack();
    return { hash: loc._h, toast: toasts.join('|') };
  }
  eq('editor→chapter 列表', backFrom('#/editor/3/7').hash, '#/chapter/7');
  eq('section→chapter', backFrom('#/section/9/4').hash, '#/chapter/9');
  eq('chapter→书章节列表', backFrom('#/chapter/5', '12').hash, '#/book/12/chapters');
  eq('chapter 无 bookId 兜底书架（禁拼空id）', backFrom('#/chapter/5').hash, '#/shelf');
  eq('book→shelf', backFrom('#/book/3/chars').hash, '#/shelf');
  ok('编辑态回退不弹退出提示', backFrom('#/editor/3/7').toast === '');
  eq('me 顶层不逐级回退', backFrom('#/me/data').hash, '#/me/data');
  ok('me 顶层首按弹“再按一次”', /再按一次/.test(backFrom('#/me/data').toast));
  // 顶层双击退出：shelf 首按提示、2.5s 内二按真退
  loc._h = '#/shelf'; A.state.flush = null; A.state.bookId = null; toasts = []; exitCalled = 0; A._lastBack = 0;
  A.onBack();
  eq('shelf 首按只提示不退出', exitCalled, 0);
  A.onBack();
  eq('shelf 二按真退出', exitCalled, 1);
  // hint 通道：界面返回按钮与系统键同一入口
  loc._h = '#/chapter/66';
  A.navigateUp('#/book/8/chapters');
  eq('hint 直达上级', loc._h, '#/book/8/chapters');
  // 覆盖层优先：有可见 .sheet 时返回只关弹层、不动路由
  loc._h = '#/editor/3/7'; A.state.flush = null; toasts = []; A._lastBack = 0;
  const sheetNode = { hidden: false, classList: { contains: () => false, remove() {} } };
  A.el = {
    querySelectorAll: sel => (sel === '.sheet' ? [sheetNode] : []),
    querySelector: () => null
  };
  A.onBack();
  ok('覆盖层被关', sheetNode.hidden === true);
  eq('关覆盖层不改路由', loc._h, '#/editor/3/7');
  eq('关覆盖层不弹退出', toasts.length, 0);
  A.el = null;

  log('');
  log('合计：' + pass + ' 通过 / ' + fail + ' 失败');
  fs.writeFileSync(path.join(__dirname, 'report-v322-fixes.txt'), lines2str(), 'utf8');
  console.log(out.filter(l => l.startsWith('  FAIL')).join('\n') || '（无失败项）');
  console.log('V322-fixes ' + pass + ' passed, ' + fail + ' failed  -> tests/report-v322-fixes.txt');
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('测试崩溃：', e); process.exitCode = 1; });
function lines2str() { return out.join('\n') + '\n'; }
