/* m8_trash.test.cjs —— 回收站/软删除全链路回归（Node 侧，node:sqlite）
   覆盖：B1 schema v6 迁移与幂等；B2 访问层过滤（list/search 隐藏软删、get* 仍可取、
   listTrash 计数、恢复回位、级联标记）；B3 到点真删（可控 deleted_at + FK CASCADE、
   emptyTrash、purgeExpired(0) 语义、days<=0）。运行：node tests/m8_trash.test.cjs */
const fs = require('node:fs');
const path = require('node:path');

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
const DAY = 86400000;

const G = globalThis;

function mkAdapter(d) {
  return {
    db: d,
    all: (sql, params) => d.prepare(sql).all(...(params || [])),
    run: (sql, params) => { const r = d.prepare(sql).run(...(params || [])); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; },
    exec: (sql) => d.exec(sql),
    close: () => d.close()
  };
}

(async () => {
  new Function(sc('schema.js'))(G);
  new Function(sc('db.js'))(G);
  const { DatabaseSync } = require('node:sqlite');
  const DB = G.NOVEL_DB;

  /* ---------- B1 迁移校验 ---------- */
  log('== B1 schema v6 迁移 ==');
  let d = new DatabaseSync(':memory:');
  let info = await DB.init(mkAdapter(d));
  eq('LATEST_VERSION=6', G.NOVEL_SCHEMA.LATEST_VERSION, 6);
  eq('toVersion=6', info.toVersion, 6);
  const cols = t => d.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  ok('books.deleted_at', cols('books').includes('deleted_at'));
  ok('chapters.deleted_at', cols('chapters').includes('deleted_at'));
  ok('sections.deleted_at', cols('sections').includes('deleted_at'));
  const idx = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%_trash'").all().map(r => r.name).sort();
  eq('三回收站索引存在', idx, ['idx_books_trash', 'idx_chapters_trash', 'idx_sections_trash']);
  // 幂等：重复 init 不报错、不重复 ADD COLUMN（迁移只在 version>from 执行）
  const info2 = await DB.init(mkAdapter(d));
  eq('重复 init 幂等 toVersion 仍 6', info2.toVersion, 6);
  ok('重复 init 不崩', true);
  d.close();

  /* ---------- 老库(先建到 v5)升 v6 ---------- */
  log('== B1 老库 v5 → v6 升级 ==');
  d = new DatabaseSync(':memory:');
  const a5 = mkAdapter(d);
  // 手动搭一个只到 v5 的库：把 MIGRATIONS 临时截到 v5 跑一遍
  const fullMigs = G.NOVEL_SCHEMA.MIGRATIONS;
  G.NOVEL_SCHEMA.MIGRATIONS = fullMigs.filter(m => m.version <= 5);
  G.NOVEL_SCHEMA.LATEST_VERSION = 5;
  let infv5 = await DB.init(a5);
  eq('老库到 v5', infv5.toVersion, 5);
  ok('v5 无 deleted_at 列', !d.prepare('PRAGMA table_info(books)').all().map(c => c.name).includes('deleted_at'));
  // 恢复完整迁移表，再 init → 从 v5 升到 v6
  G.NOVEL_SCHEMA.MIGRATIONS = fullMigs;
  G.NOVEL_SCHEMA.LATEST_VERSION = 6;
  const infv6 = await DB.init(a5);
  eq('fromVersion=5', infv6.fromVersion, 5);
  eq('升到 v6', infv6.toVersion, 6);
  ok('v6 后 books 有 deleted_at', d.prepare('PRAGMA table_info(books)').all().map(c => c.name).includes('deleted_at'));
  d.close();

  /* ---------- B2 访问层一致性 ---------- */
  log('== B2 过滤/级联/恢复 ==');
  d = new DatabaseSync(':memory:');
  await DB.init(mkAdapter(d));

  const bookId = await DB.createBook({ title: '回收站测试书' });
  const ch1 = await DB.createChapter(bookId, '第一章');
  const ch2 = await DB.createChapter(bookId, '第二章');
  await DB.saveChapterBody(ch1, '风从海面上掠过，带起一串浪花。', 'manual');
  const s1 = await DB.createSection(ch2, '第二章第一节');
  await DB.saveSectionBody(s1, '这是一个可被检索的独特词汇。');

  eq('初始 listBooks 1', (await DB.listBooks()).length, 1);
  eq('初始 listChapters 2', (await DB.listChapters(bookId)).length, 2);

  // 软删一本书 → 级联标记其章+节
  await DB.trashBook(bookId);
  eq('删书后 listBooks 0', (await DB.listBooks()).length, 0);
  eq('删书级联隐藏章', (await DB.listChapters(bookId)).length, 0);
  eq('删书级联隐藏节', (await DB.listSections(ch2)).length, 0);
  ok('getChapter 仍可取被删章', (await DB.getChapter(ch1)) !== null);
  ok('getSection 仍可取被删节', (await DB.getSection(s1)) !== null);

  // search 对被删章正文/节应 0 命中（章正文里检索）
  const hit = await DB.search(bookId, '浪花');
  eq('软删后 search 0 命中', hit.length, 0);

  // listTrash 计数：1 书 + 2 章 + 1 节
  let tr = await DB.listTrash();
  eq('listTrash books=1', tr.books.length, 1);
  eq('listTrash chapters=2', tr.chapters.length, 2);
  eq('listTrash sections=1', tr.sections.length, 1);

  // 恢复 → 三者回位、listTrash 归零
  await DB.restoreBook(bookId);
  eq('恢复后 listBooks 1', (await DB.listBooks()).length, 1);
  eq('恢复后 listChapters 2', (await DB.listChapters(bookId)).length, 2);
  tr = await DB.listTrash();
  eq('恢复后回收站空', [tr.books.length, tr.chapters.length, tr.sections.length], [0, 0, 0]);
  eq('恢复后 search 命中', (await DB.search(bookId, '浪花')).length, 1);

  // 章级：trashChapter 只连带其节，不动兄弟章
  await DB.trashChapter(ch2);
  const left = await DB.listChapters(bookId);
  eq('删单章剩 1 章', left.length, 1);
  eq('删单章隐藏其节', (await DB.listSections(ch2)).length, 0);
  ok('兄弟章 ch1 未受影响', (await DB.getChapter(ch1)).deleted_at === null);
  await DB.restoreChapter(ch2);
  eq('恢复章后 2 章', (await DB.listChapters(bookId)).length, 2);
  eq('恢复章带回其节', (await DB.listSections(ch2)).length, 1);

  /* ---------- B3 到点真删 ---------- */
  log('== B3 到点真删 + CASCADE ==');
  // 构造两本书：A 的软删时间设为 now-10天（超期），B 为刚删（未超期）
  const bookA = await DB.createBook({ title: '超期书' });
  const chA = await DB.createChapter(bookA, '超期章');
  await DB.saveChapterBody(chA, '超期正文内容将被彻底清除。', 'manual');
  const sA = await DB.createSection(chA, '超期节');
  await DB.saveSectionBody(sA, '超期节正文');
  await DB.trashBook(bookA);
  // 用适配器把 bookA 及其子项 deleted_at 改为 10 天前
  const old = Date.now() - 10 * DAY;
  d.prepare('UPDATE books SET deleted_at=? WHERE id=?').run(old, bookA);
  d.prepare('UPDATE chapters SET deleted_at=? WHERE book_id=?').run(old, bookA);
  d.prepare('UPDATE sections SET deleted_at=? WHERE book_id=?').run(old, bookA);

  const bookB = await DB.createBook({ title: '未超期书' });
  await DB.createChapter(bookB, '保留章');
  await DB.trashBook(bookB);   // deleted_at = now

  const purged = await DB.purgeExpired(7);
  ok('purgeExpired(7) 返删除数>0', purged > 0);
  // 超期书 A 硬删：get* 返 null，其章/节/快照随 CASCADE 消失
  ok('A 书已硬删', (await DB.listBooks()).every(b => b.id !== bookA));
  eq('A 章 getChapter 返 null', await DB.getChapter(chA), null);
  eq('A 节 getSection 返 null', await DB.getSection(sA), null);
  ok('A 快照随 CASCADE 清除', d.prepare('SELECT COUNT(*) AS c FROM snapshots WHERE book_id=?').all(bookA)[0].c === 0);
  // 未超期书 B 仍在回收站
  tr = await DB.listTrash();
  ok('B 仍在回收站', tr.books.some(b => b.id === bookB));

  // days<=0：立即清所有已标记（含刚删的 B）
  const purged2 = await DB.purgeExpired(0);
  ok('purgeExpired(0) 清剩 B', purged2 > 0);
  tr = await DB.listTrash();
  eq('purgeExpired(0) 后回收站空', [tr.books.length, tr.chapters.length, tr.sections.length], [0, 0, 0]);

  // emptyTrash：再删一批后清空
  const bookC = await DB.createBook({ title: '清空书' });
  const chC = await DB.createChapter(bookC, '清空章');
  await DB.trashBook(bookC);
  await DB.emptyTrash();
  eq('emptyTrash 后书消失', await DB.getChapter(chC), null);
  tr = await DB.listTrash();
  eq('emptyTrash 后回收站空', [tr.books.length, tr.chapters.length, tr.sections.length], [0, 0, 0]);

  // purgeOne：单独彻底删一条节
  const bookD = await DB.createBook({ title: '单删书' });
  const chD = await DB.createChapter(bookD, '单删章');
  const sD = await DB.createSection(chD, '单删节');
  await DB.trashSection(sD);
  eq('trashSection 后节进回收站', (await DB.listTrash()).sections.length, 1);
  await DB.purgeOne('section', sD);
  eq('purgeOne 后节硬删', await DB.getSection(sD), null);
  eq('purgeOne 后回收站空节', (await DB.listTrash()).sections.length, 0);
  ok('purgeOne 未知类型报错', await DB.purgeOne('bogus', 1).then(() => false, () => true));

  d.close();
  log('');
  log(`合计：${pass} 通过 / ${fail} 失败`);
  fs.writeFileSync(path.join(__dirname, 'report-m8-trash.txt'), out.join('\n'), 'utf8');
  process.stdout.write(out.join('\n') + '\n');
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('测试自身异常:', e); fs.writeFileSync(path.join(__dirname, 'report-m8-trash.txt'), out.join('\n') + '\n异常: ' + (e.stack || e), 'utf8'); process.exitCode = 2; });