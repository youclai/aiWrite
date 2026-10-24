/* m10_characters.test.cjs —— 人物卡性别/年龄与“人生走向”文案（优化批次 B）回归（Node 侧）
   覆盖：schema v7 迁移（新列/老库升级/默认空串/幂等）、saveCharacter 存取 round-trip、
   prompt.formatCharacter 新行与“禁忌”字样退场（列名 taboos 不改的约定也一并钉死）。
   运行：node tests/m10_characters.test.cjs ；退出码 0=全绿。 */
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

function makeAdapter(d) {
  d = d || new DatabaseSync(':memory:');
  return {
    db: d,
    all: (sql, params) => d.prepare(sql).all(...(params || [])),
    run: (sql, params) => { const r = d.prepare(sql).run(...(params || [])); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; },
    exec: (sql) => d.exec(sql),
    close: () => d.close()
  };
}

(async () => {
  for (const f of ['schema.js', 'db.js', 'prompt.js']) new Function(sc(f))(G);
  const DB = G.NOVEL_DB, S = G.NOVEL_SCHEMA, P = G.NOVEL_PROMPT;

  /* ============ C1 全新库直上 v7 ============ */
  ok('C1 LATEST_VERSION=7', S.LATEST_VERSION === 7);
  let d = new DatabaseSync(':memory:');
  let info = await DB.init(makeAdapter(d));
  eq('C1 全新库 toVersion=7', info.toVersion, 7);
  const cols = d.prepare('PRAGMA table_info(characters)').all().map(c => c.name);
  ok('C1 characters 有 gender 列', cols.includes('gender'));
  ok('C1 characters 有 age 列', cols.includes('age'));
  ok('C1 taboos 列名保留（不迁移）', cols.includes('taboos'));
  const notNull = d.prepare("SELECT name, \"notnull\" AS n, dflt_value AS dv FROM pragma_table_info('characters') WHERE name IN ('gender','age')").all();
  eq('C1 两列 NOT NULL 默认空串', notNull.map(r => [r.name, r.n === 1, r.dv]).sort(), [['age', true, "''"], ['gender', true, "''"]]);
  d.close();

  /* ============ C2 老库 v6 → v7：旧行默认空、幂等 ============ */
  d = new DatabaseSync(':memory:');
  const a = makeAdapter(d);
  const fullMigs = S.MIGRATIONS, fullVer = S.LATEST_VERSION;
  S.MIGRATIONS = fullMigs.filter(m => m.version <= 6);
  S.LATEST_VERSION = 6;
  await DB.init(a);
  const bookId = await DB.createBook({ title: 'v6老书' });
  // 旧行用裸 SQL 插（此时表尚无 gender/age 列，模拟 v6 时代写入）
  const t0 = Date.now();
  const insRes = a.run("INSERT INTO characters (book_id,name,role,aliases,personality,speech_style,taboos,background,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [bookId, '旧角色', '配角', '[]', '', '', '怕水', '', t0, t0]);
  const oldId = insRes.lastId;
  S.MIGRATIONS = fullMigs;
  S.LATEST_VERSION = fullVer;
  const up = await DB.init(a);
  eq('C2 v6→v7 fromVersion', up.fromVersion, 6);
  eq('C2 v6→v7 toVersion', up.toVersion, 7);
  const again = await DB.init(a);   // 幂等：重复 init 不炸
  eq('C2 重复 init 仍 7', again.toVersion, 7);
  const oldRow = (await DB.listCharacters(bookId)).filter(c => c.id === oldId)[0];
  eq('C2 旧行 gender 默认空串', oldRow.gender, '');
  eq('C2 旧行 age 默认空串', oldRow.age, '');
  eq('C2 旧行 taboos 数据不丢', oldRow.taboos, '怕水');

  /* ============ C3 saveCharacter round-trip ============ */
  const id2 = await DB.saveCharacter(bookId, {
    name: '林晚', role: '主角', gender: '女', age: '二十多岁',
    personality: '外冷内热', speech_style: '短句', taboos: '少年家变、终弃暗投明', background: '孤儿', aliases: ['阿晚']
  });
  const row2 = (await DB.listCharacters(bookId)).filter(c => c.id === id2)[0];
  eq('C3 gender 存取一致', row2.gender, '女');
  eq('C3 age 容纳模糊说法', row2.age, '二十多岁');
  eq('C3 taboos 承载人生走向文本', row2.taboos, '少年家变、终弃暗投明');
  // 更新走同一条：改 gender 不丢其它字段
  await DB.saveCharacter(bookId, Object.assign({}, row2, { gender: '其他' }), id2);
  const row2b = (await DB.listCharacters(bookId)).filter(c => c.id === id2)[0];
  eq('C3 编辑后 gender 更新', row2b.gender, '其他');
  eq('C3 编辑后 age 不丢', row2b.age, '二十多岁');
  d.close();

  /* ============ C4 prompt.formatCharacter 文案 ============ */
  const txtOn = P.formatCharacter({ name: '林晚', role: '主角', gender: '女', age: '二十多岁',
    aliases: ['阿晚'], personality: '外冷内热', speech_style: '短句', taboos: '少年家变' }, true);
  ok('C4 注入含 性别行', txtOn.indexOf('性别：女') >= 0);
  ok('C4 注入含 年龄行', txtOn.indexOf('年龄：二十多岁') >= 0);
  ok('C4 注入含 人生走向行', txtOn.indexOf('人生走向：少年家变') >= 0);
  ok('C4 不再出现“禁忌”字样', txtOn.indexOf('禁忌') < 0);
  const txtOff = P.formatCharacter({ name: '林晚', gender: '女', taboos: '少年家变' }, false);
  ok('C4 开关关闭不注入人生走向', txtOff.indexOf('人生走向') < 0);
  ok('C4 开关关闭仍注入性别', txtOff.indexOf('性别：女') >= 0);
  const txtMin = P.formatCharacter({ name: '路人' }, true);
  ok('C4 空字段不产生空行', txtMin.indexOf('性别') < 0 && txtMin.indexOf('年龄') < 0 && txtMin.indexOf('人生走向') < 0);

  const failed = fail;
  console.log(out.join('\n'));
  console.log(`\n[单测] 通过 ${pass} 失败 ${failed}`);
  fs.writeFileSync(path.join(__dirname, 'report-m10-characters.txt'), out.join('\n') + `\n\n合计 ${pass + failed} 项，失败 ${failed} 项。\n`, 'utf8');
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
