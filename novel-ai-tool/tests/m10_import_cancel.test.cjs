/* m10_import_cancel.test.cjs —— 导入进度/取消回滚（优化批次 G）回归（Node 侧，node:sqlite）
   覆盖：onProgress 单调递增至 total；协作式取消只在章/节边界生效；
   new 取消→deleteBook 一步还原（books/chapters/sections 计数归零）；
   merge 取消→仅删本次 createdChapterIds、既有章正文一字未动；
   sectionOnly 取消→仅删本次 createdSectionIds、目标章 body 不变；
   非取消的失败→不清除、保留现场可重试（err.imported/total，无 removed）。
   运行：node tests/m10_import_cancel.test.cjs ；退出码 0=全绿。 */
const fs = require('node:fs');
const path = require('node:path');
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
const ok = (name, cond) => eq(name, !!cond, true);
const G = globalThis;

function makeAdapter() {
  const d = new DatabaseSync(':memory:');
  const a = {
    db: d,
    all: (sql, params) => d.prepare(sql).all(...(params || [])),
    run: (sql, params) => { const r = d.prepare(sql).run(...(params || [])); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; },
    exec: (sql) => d.exec(sql),
    close: () => d.close(),
    count: (t) => d.prepare('SELECT COUNT(*) AS c FROM ' + t).all()[0].c   // 硬数：绕过软删过滤
  };
  return a;
}

const TEXT3 = '第1章 甲\n\u3000\u3000内容甲。\n第2章 乙\n\u3000\u3000内容乙。\n第3章 丙\n\u3000\u3000内容丙。';
const SECT3 = '第1节 一\n\u3000\u3000节内一。\n第2节 二\n\u3000\u3000节内二。\n第3节 三\n\u3000\u3000节内三。';

(async () => {
  for (const f of ['schema.js', 'db.js', 'importer.js', 'structuredImport.js', 'dataActions.js']) new Function(sc(f))(G);
  const DB = G.NOVEL_DB, DA = G.NOVEL_DATA_ACTIONS;
  ok('模块齐备', DB && DA && typeof DA.importBook === 'function');

  /* ============ N1 new 模式：第 1 章写完即取消 → 整书一步还原 ============ */
  {
    const a = makeAdapter(); await DB.init(a);
    const cancelRef = { cancelled: false };
    const prog = (done) => { if (done >= 1) cancelRef.cancelled = true; };
    let err = null;
    try { await DA.importBook({ db: DB }, { mode: 'new', title: '取消书', text: TEXT3, format: 'split', onProgress: prog, cancelRef }); }
    catch (e) { err = e; }
    ok('N1 reject 带 cancelled 标记', err && err.cancelled === true);
    eq('N1 已写入章数', err.imported, 1);
    eq('N1 回滚删书成功(removed=1 本书)', err.removed, 1);
    eq('N1 回滚零失败', err.rollbackFailed, 0);
    eq('N1 books 表归零', a.count('books'), 0);
    eq('N1 chapters 表归零', a.count('chapters'), 0);
    eq('N1 listBooks 空', (await DB.listBooks()).length, 0);
    a.close();
  }

  /* ============ N2 merge 模式：第 2 章后取消 → 只删本次新章，既有章一字未动 ============ */
  {
    const a = makeAdapter(); await DB.init(a);
    const bookId = await DB.createBook({ title: '既有书' });
    const keepId = await DB.createChapter(bookId, '既有第一章');
    await DB.saveChapterBody(keepId, '既有正文绝对不动。', 'manual');
    const cancelRef = { cancelled: false };
    const prog = (done) => { if (done >= 2) cancelRef.cancelled = true; };
    let err = null;
    try { await DA.importBook({ db: DB }, { mode: 'merge', bookId: bookId, text: TEXT3, format: 'split', onProgress: prog, cancelRef }); }
    catch (e) { err = e; }
    ok('N2 cancelled 标记', err && err.cancelled === true);
    eq('N2 已写入 2 章', err.imported, 2);
    eq('N2 清除 2 章', err.removed, 2);
    eq('N2 回滚零失败', err.rollbackFailed, 0);
    eq('N2 仅剩既有章', a.count('chapters'), 1);
    const kept = await DB.getChapter(keepId);
    eq('N2 既有章正文未动', kept.body, '既有正文绝对不动。');
    a.close();
  }

  /* ============ N3 sectionOnly：第 2 节后取消 → 只删本次新节，章 body 不变 ============ */
  {
    const a = makeAdapter(); await DB.init(a);
    const bookId = await DB.createBook({ title: '单节书' });
    const chapId = await DB.createChapter(bookId, '目标章');
    await DB.saveChapterBody(chapId, '章正文原样。', 'manual');
    const cancelRef = { cancelled: false };
    const prog = (done) => { if (done >= 2) cancelRef.cancelled = true; };
    let err = null;
    try { await DA.importBook({ db: DB }, { mode: 'merge', bookId: bookId, chapterId: chapId, text: SECT3, format: 'sectionOnly', onProgress: prog, cancelRef }); }
    catch (e) { err = e; }
    ok('N3 cancelled 标记', err && err.cancelled === true);
    eq('N3 已写入 2 节', err.imported, 2);
    eq('N3 清除 2 节', err.removed, 2);
    eq('N3 回滚单位=节', err.rollbackUnit, '节');
    eq('N3 sections 归零', a.count('sections'), 0);
    const ch = await DB.getChapter(chapId);
    eq('N3 目标章 body 不变', ch.body, '章正文原样。');
    a.close();
  }

  /* ============ N4 正常跑完：onProgress 单调递增、total 恒定、达 total，内容全保留 ============ */
  {
    const a = makeAdapter(); await DB.init(a);
    const calls = [];
    const r = await DA.importBook({ db: DB }, {
      mode: 'new', title: '进度书', text: '第1章 甲\n内容甲\n\n第1节 子一\n子文一\n\n第2章 乙\n内容乙\n\n第3章 丙\n内容丙\n\n第4章 丁\n内容丁',
      format: 'split',
      onProgress: (done, total, secDone) => calls.push({ done: done, total: total, sec: secDone })
    });
    ok('N4 有回调', calls.length >= 4);
    ok('N4 done 单调不减', calls.every((c, i) => i === 0 || c.done >= calls[i - 1].done));
    eq('N4 total 恒定', [...new Set(calls.map(c => c.total))].length, 1);
    const last = calls[calls.length - 1];
    eq('N4 最终 done=total=4', [last.done, last.total], [4, 4]);
    eq('N4 结果章数', r.chapters, 4);
    eq('N4 结果节数', r.sections, 1);
    eq('N4 库里章完整', a.count('chapters'), 4);
    a.close();
  }

  /* ============ N5 非取消的失败：不清除，保留“已成功 k/n”现场可重试 ============ */
  {
    const a = makeAdapter(); await DB.init(a);
    let n = 0;
    const fakeDb = Object.assign({}, DB, {
      saveChapterBody: function (cid, body, reason) {
        n++;
        if (n === 2) return Promise.reject(new Error('模拟第 2 章落盘炸库'));
        return DB.saveChapterBody(cid, body, reason);
      }
    });
    let err = null;
    try { await DA.importBook({ db: fakeDb }, { mode: 'new', title: '失败书', text: TEXT3, format: 'split' }); }
    catch (e) { err = e; }
    ok('N5 失败不带 cancelled', err && !err.cancelled);
    eq('N5 已成功 1/3', [err.imported, err.total], [1, 3]);
    eq('N5 未触发回滚(无 removed)', err.removed === undefined, true);
    eq('N5 现场保留：已写 1 章+失败中的空壳章均未删', a.count('chapters'), 2);
    eq('N5 书也保留', a.count('books'), 1);
    a.close();
  }

  const failed = fail;
  console.log(out.join('\n'));
  console.log(`\n[单测] 通过 ${pass} 失败 ${failed}`);
  fs.writeFileSync(path.join(__dirname, 'report-m10-import-cancel.txt'), out.join('\n') + `\n\n合计 ${pass + failed} 项，失败 ${failed} 项。\n`, 'utf8');
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
