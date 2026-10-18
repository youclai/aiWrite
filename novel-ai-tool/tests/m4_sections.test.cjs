/* m4_sections.test.cjs —— 节（章 > 节）数据层 CRUD 回归（Node 侧，node:sqlite）
   覆盖 schema v4 迁移、createSection 自动取 book_id/idx、body/draft/meta 写回、
   reorder、delete、级联删章连带删节。运行：node tests/m4_sections.test.cjs */
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

const G = globalThis;
(async () => {
  new Function(sc('schema.js'))(G);
  new Function(sc('db.js'))(G);

  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(':memory:');
  const adapter = {
    db: d,
    all: (sql, params) => d.prepare(sql).all(...(params || [])),
    run: (sql, params) => { const r = d.prepare(sql).run(...(params || [])); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; },
    exec: (sql) => d.exec(sql),
    close: () => d.close()
  };
  const info = await G.NOVEL_DB.init(adapter);
  const DB = G.NOVEL_DB;

  log('== schema 迁移到 v4 ==');
  eq('toVersion=4', info.toVersion, G.NOVEL_SCHEMA.LATEST_VERSION);
  ok('LATEST_VERSION>=4', G.NOVEL_SCHEMA.LATEST_VERSION >= 4);
  const hasTbl = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sections'").all();
  ok('sections 表已建', hasTbl.length === 1);

  log('== 节 CRUD ==');
  const bookId = await DB.createBook({ title: '节测试书' });
  const chapId = await DB.createChapter(bookId, '第一章');

  const s1 = await DB.createSection(chapId, '第1节');
  const s2 = await DB.createSection(chapId, '第2节');
  ok('createSection 返 id', s1 > 0 && s2 > s1);

  const secs = await DB.listSections(chapId);
  eq('listSections 两条', secs.length, 2);
  eq('idx 递增', secs.map(s => s.idx), [1, 2]);
  eq('自动带 book_id', secs[0].book_id, bookId);
  eq('自动带 chapter_id', secs[0].chapter_id, chapId);

  // body 写回 + 字数
  const wc = await DB.saveSectionBody(s1, '夜色沉下来，灯一盏盏亮了。');
  eq('saveSectionBody 返字数', wc, 13);
  let g = await DB.getSection(s1);
  eq('正文已存', g.body, '夜色沉下来，灯一盏盏亮了。');
  eq('word_count 落库', g.word_count, 13);

  // draft（打字自动保存，不快照）
  await DB.saveSectionDraft(s1, '草稿内容');
  g = await DB.getSection(s1);
  eq('saveSectionDraft 覆盖正文', g.body, '草稿内容');

  // meta
  await DB.saveSectionMeta(s1, { title: '改名节', summary: '摘' });
  g = await DB.getSection(s1);
  eq('saveSectionMeta 改标题', g.title, '改名节');
  eq('saveSectionMeta 改摘要', g.summary, '摘');
  eq('meta 不动正文', g.body, '草稿内容');

  // reorder：把 s2 排到 s1 前
  await DB.reorderSections(chapId, [s2, s1]);
  const ordered = await DB.listSections(chapId);
  eq('reorder 生效', ordered.map(s => s.id), [s2, s1]);

  // delete
  await DB.deleteSection(s2);
  eq('deleteSection 剩一条', (await DB.listSections(chapId)).length, 1);

  // 级联：删章 → 节随 ON DELETE CASCADE 清除
  await DB.deleteChapter(chapId);
  eq('删章级联删节', (await DB.listSections(chapId)).length, 0);

  log('');
  log(`合计：${pass} 通过 / ${fail} 失败`);
  fs.writeFileSync(path.join(__dirname, 'report-m4-sections.txt'), out.join('\n'), 'utf8');
  process.stdout.write(out.join('\n') + '\n');
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('测试自身异常:', e); process.exitCode = 2; });
