/* m6_backup.test.cjs —— M6-d 备份/恢复无头自检（Node 侧，node:sqlite，不上真机）
 * 覆盖：整库导出→读回→恢复到新库；密钥剔除（api_key 绝不入包）；版本闸拒绝过新；
 *       safety hook 必在恢复语句之前；恢复中途失败整体回滚（不破坏原库）。
 * 落 safety_<ts>.db / temp/backup / 真机文件读写留 App 联调。 */
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

(async () => {
  // 载入模块：schema/db 提供真实数据；zip + backup 是被测件
  new Function(sc('schema.js'))(G);
  new Function(sc('zip.js'))(G);
  new Function(sc('backup.js'))(G);
  const BK = G.NOVEL_BACKUP;
  const VER = G.NOVEL_SCHEMA.LATEST_VERSION;   // 版本相关断言不写死，随迁移自动适配

  /* ---------- 造一个有内容的库 ---------- */
  const a1 = makeAdapter();
  new Function(sc('db.js'))(G);          // db.js 读 NOVEL_SCHEMA，需先于其后加载
  await G.NOVEL_DB.init(a1);
  const DB = G.NOVEL_DB;
  const bookId = await DB.createBook({ title: '备份测试书', synopsis: '梗概A', style_note: '冷硬' });
  const chapId = await DB.createChapter(bookId);
  const trickyBody = '第一行；含分号。第二行 有"引号" 和 & <符号> 以及中文。';
  const finalBody = trickyBody + '（终稿）';
  await DB.saveChapterBody(chapId, trickyBody, 'create');     // 空→trickyBody：无快照（符合设计）
  await DB.saveChapterBody(chapId, finalBody, 'adopt');        // trickyBody→终稿：自动快照 trickyBody
  const charId = await DB.saveCharacter(bookId, { name: '林深', role: '主角', aliases: ['小深'], taboos: '不近女色' });
  await DB.startJob({ book_id: bookId, kind: 'polish', provider: 'mock', model: 'mock' });
  // 模拟“某处误把密钥塞进 settings”——备份必须纵深剔除
  const LEAK = 'sk-SUPERSECRET-123456';
  await DB.setSetting('api', { provider: 'openai', model: 'gpt-x', key_set: true, api_key: LEAK });

  log('== 导出打包 ==');
  const bk = await BK.buildBackup(a1, { book_title: '备份测试书', created_at: 1700000000000 });
  ok('manifest 记录各表', ['books', 'chapters', 'characters', 'snapshots', 'templates', 'settings', 'ai_jobs']
    .every(t => bk.manifest.tables.indexOf(t) >= 0), bk.manifest.tables.join(','));
  ok('manifest 不含 FTS 虚表', bk.manifest.tables.every(t => !/fts/i.test(t)), bk.manifest.tables.join(','));
  ok('counts 章节=1', bk.manifest.counts.chapters === 1, bk.manifest.counts.chapters);
  ok('counts 角色=1 快照>=1', bk.manifest.counts.characters === 1 && bk.manifest.counts.snapshots >= 1);
  eq('schema_version=LATEST', bk.manifest.schema_version, VER);
  ok('产物是 zip 字节', bk.bytes instanceof Uint8Array && bk.bytes[0] === 0x50 && bk.bytes[1] === 0x4b);

  log('== 密钥绝不入包 ==');
  ok('manifest 标记剔除了 api_key', (bk.manifest.redacted_secret_fields || []).some(p => /api_key/.test(p)),
    JSON.stringify(bk.manifest.redacted_secret_fields));
  eq('包内扫描查不到泄漏密钥', BK.scanSecrets(bk.bytes, [LEAK]), []);
  // 非敏感字段应保留
  const reRead = BK.readBackup(bk.bytes);
  const settingsStmt = reRead.statements.find(s => /INSERT INTO settings/.test(s.sql) && JSON.stringify(s.params).indexOf('"api"') >= 0);
  ok('settings api 行保留 provider', settingsStmt && JSON.stringify(settingsStmt.params).indexOf('openai') >= 0);
  ok('settings api 行已无 api_key 值', settingsStmt && JSON.stringify(settingsStmt.params).indexOf(LEAK) < 0);

  log('== 恢复到全新库 ==');
  const a2 = makeAdapter();
  await DB.init(a2);                       // 迁移出 schema（同单库单例，稍后再 init）
  const safetyOrder = [];
  const r = await BK.restore(a2, reRead, {
    currentVersion: VER,
    now: () => 1700000009999,
    makeSafety: () => { safetyOrder.push('safety'); return Promise.resolve(); }
  });
  ok('恢复成功', r.ok, r.reason);
  ok('safety 先于 apply', r.order && r.order[0] === 'safety' && r.order[1] === 'apply', JSON.stringify(r.order));
  const chs = a2.all('SELECT body FROM chapters', []);
  ok('恢复后章节数=1', chs.length === 1);
  eq('特殊字符正文无损往返(分号/引号/&<>)', chs[0] && chs[0].body, finalBody);
  eq('恢复后角色=1', a2.all('SELECT * FROM characters', []).length, 1);
  ok('恢复后快照保留', a2.all('SELECT * FROM snapshots', []).length >= 1);
  ok('恢复后模板存在(内置7条)', a2.all('SELECT * FROM templates', []).length >= 7);
  const apiVal = (a2.all("SELECT value_json FROM settings WHERE key='api'", [])[0] || {}).value_json;
  ok('恢复库 settings 无泄漏密钥', apiVal && apiVal.indexOf(LEAK) < 0, apiVal);

  log('== 版本闸：拒绝过新 ==');
  const tooNew = { manifest: Object.assign({}, reRead.manifest, { schema_version: 99999 }), statements: reRead.statements };
  const safetyHits = [];
  const rv = await BK.restore(a2, tooNew, { currentVersion: VER, makeSafety: () => { safetyHits.push(1); return Promise.resolve(); } });
  eq('过新备份被拒', [rv.ok, rv.reason], [false, 'version-too-new']);
  eq('拒绝时不触发 safety', safetyHits.length, 0);

  log('== 恢复中途失败：整体回滚不破坏原库 ==');
  const beforeBooks = a2.all('SELECT COUNT(*) AS c FROM books', [])[0].c;
  const bad = { manifest: reRead.manifest, statements: [{ sql: 'DELETE FROM books', params: [] }, { sql: 'INSERT INTO __nope(x) VALUES (?)', params: [1] }] };
  const rb = await BK.restore(a2, bad, { currentVersion: VER, makeSafety: () => Promise.resolve() });
  eq('失败返回 apply-failed', [rb.ok, rb.reason], [false, 'apply-failed']);
  const afterBooks = a2.all('SELECT COUNT(*) AS c FROM books', [])[0].c;
  eq('失败已回滚(books 行数不变)', afterBooks, beforeBooks);

  log('== 纯函数：敏感字段剔除 ==');
  const red = BK._internal.redactSensitive({ api_key: 'x', nested: { access_token: 'y', keep: 1 }, list: [{ password: 'z', n: 2 }] }, '', []);
  eq('剔除 api_key/access_token/password', red.redacted.slice().sort(), ['api_key', 'list[0].password', 'nested.access_token']);
  eq('非敏感键保留', red.value, { nested: { keep: 1 }, list: [{ n: 2 }] });
  ok('key_set 不被误剔', BK._internal.SECRET_FIELD.test('key_set') === false);

  a1.close(); a2.close();

  const failed = fail;
  log('');
  log(`合计：${pass} 通过 / ${failed} 失败`);
  fs.writeFileSync(path.join(__dirname, 'report-m6-backup.txt'), out.join('\n') + '\n', 'utf8');
  console.log('通过 ' + pass + ' 失败 ' + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  fs.writeFileSync(path.join(__dirname, 'report-m6-backup.txt'), 'HARNESS ERROR: ' + (e && e.stack || e) + '\n' + out.join('\n'), 'utf8');
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
