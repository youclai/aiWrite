/* m6_storage.test.cjs —— M6-f 存储统计逻辑层无头自检（Node，node:sqlite + 真实 temp fs）
 * 覆盖：各表行数/总字数/AI 用量分组/库体积(page×size)/某书明细/temp 占用与文件系统一致/无 temp 优雅降级。
 * 视图 pages/storage.js 的真机目视不在本轮。 */
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
const ok = (name, cond, msg) => eq(name, !!cond, true);
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
    readFile: rel => fs.readFileSync(abs(rel), 'utf8'),
    exists: rel => fs.existsSync(abs(rel)),
    readdir: rel => fs.readdirSync(abs(rel), { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() })),
    deleteFile: rel => { fs.rmSync(abs(rel), { force: true }); },
    removeDir: rel => { fs.rmSync(abs(rel), { recursive: true, force: true }); },
    stat: rel => ({ size: fs.statSync(abs(rel)).size })
  };
}

(async () => {
  new Function(sc('schema.js'))(G);
  new Function(sc('db.js'))(G);
  new Function(sc('tempStore.js'))(G);
  new Function(sc('storage.js'))(G);
  const ST = G.NOVEL_STORAGE;
  const DB = G.NOVEL_DB;

  /* ---------- 造库 ---------- */
  const ad = makeAdapter();
  await DB.init(ad);
  const bookId = await DB.createBook({ title: '统计书', synopsis: 'x' });
  const bookId2 = await DB.createBook({ title: '第二本' });
  const c1 = await DB.createChapter(bookId);
  const c2 = await DB.createChapter(bookId);
  await DB.saveChapterBody(c1, '一二三四五', 'create');          // 5 字
  await DB.saveChapterBody(c2, '六七八九十百', 'create');         // 6 字
  await DB.saveCharacter(bookId, { name: '甲' });
  // AI 作业：一条 ok、一条 failed
  const j1 = await DB.startJob({ book_id: bookId, kind: 'polish', provider: 'mock', model: 'mock' }); await DB.finishJob(j1, { status: 'ok', output_chars: 10 });
  const j2 = await DB.startJob({ book_id: bookId, kind: 'expand', provider: 'mock', model: 'mock' }); await DB.finishJob(j2, { status: 'failed', error: 'e' });

  const s = await ST.collect({ db: ad });

  log('== 表行数（与库一致）==');
  ok('tables.books=2', s.tables.books === 2, s.tables.books);
  ok('tables.chapters=2', s.tables.chapters === 2, s.tables.chapters);
  ok('tables.characters=1', s.tables.characters === 1, s.tables.characters);
  ok('tables.ai_jobs=2', s.tables.ai_jobs === 2, s.tables.ai_jobs);
  ok('tableList 不含 FTS/内部表', s.tableList.every(t => !/fts/i.test(t) && !/^sqlite_/.test(t)), s.tableList.join(','));

  log('== 总字数 / AI 用量 ==');
  ok('totals.words=11(5+6)', s.totals.words === 11, s.totals.words);
  eq('ai.total=2', s.ai.total, 2);
  eq('ai.failed=1', s.ai.failed, 1);
  eq('ai.byStatus{ok,failed}', [s.ai.byStatus.ok, s.ai.byStatus.failed], [1, 1]);

  log('== 库体积 page×size ==');
  ok('database.bytes>0', s.database.bytes > 0, JSON.stringify(s.database));
  eq('database.bytes=pages*pageSize', s.database.bytes, s.database.pages * s.database.pageSize);

  log('== 某书明细（opts.bookId）==');
  const sb = await ST.collect({ db: ad }, { bookId });
  eq('book.chapters=2', sb.book.chapters, 2);
  eq('book.words=11', sb.book.words, 11);
  eq('book.characters=1', sb.book.characters, 1);
  // 第二本无内容
  const sb2 = await ST.collect({ db: ad }, { bookId: bookId2 });
  eq('第二本 chapters=0', sb2.book.chapters, 0);

  log('== temp 占用与文件系统一致 ==');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-stat-'));
  await G.NOVEL_TEMP.init(makeNodeFs(tmpRoot));
  await G.NOVEL_TEMP.write('export', 'a.txt', 'hello');                 // 5 字节
  await G.NOVEL_TEMP.write('export', 'b.txt', '12345678');             // 8 字节
  await G.NOVEL_TEMP.write('characters', '卡.md', '张三');              // utf8 6 字节
  const st2 = await ST.collect({ db: ad, temp: G.NOVEL_TEMP });
  ok('temp.total.files=3', st2.temp.total.files === 3, st2.temp.total.files);
  ok('temp.export.files=2', st2.temp.byCategory.export.files === 2, st2.temp.byCategory.export.files);
  eq('temp.export.bytes=13(与磁盘一致)', st2.temp.byCategory.export.bytes, 5 + 8);
  eq('temp.characters.bytes=6(中文 utf8)', st2.temp.byCategory.characters.bytes, 6);

  log('== 优雅降级 ==');
  const sNoTemp = await ST.collect({ db: ad });          // 不传 temp
  eq('无 temp 注入时 temp=null', sNoTemp.temp, null);
  await ST.collect({}).then(() => ok('缺适配器应 reject', false), () => ok('缺适配器 reject', true));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  ad.close();

  log(''); log(`合计：${pass} 通过 / ${fail} 失败`);
  fs.writeFileSync(path.join(__dirname, 'report-m6-storage.txt'), out.join('\n') + '\n', 'utf8');
  console.log('通过 ' + pass + ' 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  fs.writeFileSync(path.join(__dirname, 'report-m6-storage.txt'), 'HARNESS ERROR: ' + (e && e.stack || e) + '\n' + out.join('\n'), 'utf8');
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
