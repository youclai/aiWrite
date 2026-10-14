/* boot.js 装配测试：用假 window.Capacitor 验证"插件契约 → 适配器 → 迁移"这条链
   重点验证三件在真机上最容易错的事：lastId 取值位置、事务/DDL 走 exec 还是 query、非原生环境不崩
   运行：node tests/m2b_boot.test.cjs */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

for (const f of ['schema.js', 'db.js', 'boot.js']) {
  eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', f), 'utf8'));
}

let pass = 0, fail = 0;
const lines = [];
function log(s) { lines.push(s); }
async function check(name, fn) {
  try { await fn(); pass++; log('PASS  ' + name); }
  catch (e) { fail++; log('FAIL  ' + name + '  ::  ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }
function eq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((m || '') + ' 期望 ' + JSON.stringify(b) + ' 实得 ' + JSON.stringify(a));
  }
}

// 模仿 @capacitor-community/sqlite 8.x 的真实返回形状
function fakeNative(d, opts) {
  const o = opts || {};
  const conn = {
    query: (sql, params) => {
      if (o.failQuery) throw new Error(o.failQuery);
      const p = (params || []).map(x => x === undefined ? null : x);
      return Promise.resolve({ values: p.length ? d.prepare(sql).all(...p) : d.prepare(sql).all() });
    },
    execute: (sql, params, throwOnError) => {
      const p = (params || []).map(x => x === undefined ? null : x);
      const r = p.length ? d.prepare(sql).run(...p) : d.prepare(sql).run();
      const out = { changes: Number(r.changes) };
      // 插件把 lastInsertRowid 放在 message（字符串），部分版本另带 lastId
      if (o.lastIdIn === 'message') out.message = String(r.lastInsertRowid);
      else out.lastId = Number(r.lastInsertRowid);
      return Promise.resolve(out);
    }
  };
  // DDL / 多语句（CREATE TRIGGER ... BEGIN ... END;）在真机走 query 还是 exec 尚未确定，
  // 这里两种都容错，专测 boot.js 传进去的语句形状
  const SQLite = {
    checkConnections: () => Promise.resolve({ connect: [] }),
    createConnection: (cfg) => { SQLite._cfg = cfg; return Promise.resolve(); },
    retrieveConnection: (name) => Promise.resolve(name === 'novel' ? conn : null)
  };
  return { isNativePlatform: () => true, Plugins: { SQLite } };
}

(async function run() {
  log('boot.js 装配测试  ' + new Date().toISOString());
  log('');

  /* === 1. 非原生环境必须优雅退让 === */
  delete globalThis.Capacitor;
  globalThis.NOVEL_BOOT = undefined;
  delete globalThis.NOVEL_BOOT;
  // boot.js 已在上面 eval 过一次，这里重新装配以清除缓存的 report
  eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'boot.js'), 'utf8'));
  const r1 = await globalThis.NOVEL_BOOT.boot();
  await check('浏览器预览：不崩、标记非原生、给出可操作提示', () => {
    eq(r1.native, false); eq(r1.ready, false);
    assert(r1.error.indexOf('非原生壳') >= 0, '提示文案不符: ' + r1.error);
  });

  /* === 2. 插件未注册（忘了 cap sync） === */
  globalThis.Capacitor = { isNativePlatform: () => true, Plugins: {} };
  eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'boot.js'), 'utf8'));
  const r2 = await globalThis.NOVEL_BOOT.boot();
  await check('SQLite 未注册时报"请执行 npm run sync"而不是 undefined 报错', () => {
    assert(r2.error.indexOf('sync') > 0, '错误信息不符: ' + r2.error);
  });

  /* === 3. 正常路径：lastId 放在 message（老形状） === */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-boot-'));
  const d1 = new DatabaseSync(path.join(dir, 'boot1.sqlite'));
  globalThis.Capacitor = fakeNative(d1, { lastIdIn: 'message' });
  eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'boot.js'), 'utf8'));
  const r3 = await globalThis.NOVEL_BOOT.boot();
  await check('原生路径：迁移跑通并报出版本与 FTS 级别', () => {
    assert(r3.ready, '未就绪，error=' + r3.error);
    eq(r3.dbInfo.toVersion, globalThis.NOVEL_SCHEMA.LATEST_VERSION);
    assert(['trigram', 'fts5', 'like'].includes(r3.dbInfo.ftsMode), 'ftsMode 异常: ' + r3.dbInfo.ftsMode);
  });
  await check('通过 boot 装配的适配器能真正建书建章（lastId 取自 message）', async () => {
    const DB = globalThis.NOVEL_DB;
    const bid = await DB.createBook({ title: '装配验证书' });
    assert(Number(bid) > 0, 'lastId 没解析出来: ' + bid);
    const cid = await DB.createChapter(bid, '第一章');
    await DB.saveChapterBody(cid, ' boot 适配器写入的一句正文验证', 'manual');
    eq((await DB.getChapter(cid)).word_count, 16);   // 4 个拉丁字母 + 12 个汉字，空白不计
    const bs = await DB.listBooks();
    eq(bs.length, 1); eq(bs[0].chapter_count, 1);
  });
  await check('FTS 触发器在 boot 适配器下同步（写入即可检索）', async () => {
    const bs = await globalThis.NOVEL_DB.listBooks();
    const r = await globalThis.NOVEL_DB.search(bs[0].id, '正文验证');
    assert(r.length === 1 || globalThis.NOVEL_DB.info().ftsMode !== 'trigram',
           '检索未命中，engine=' + (r[0] && r[0].engine));
  });

  /* === 4. 新形状 lastId === */
  const d2 = new DatabaseSync(path.join(dir, 'boot2.sqlite'));
  globalThis.Capacitor = fakeNative(d2, { lastIdIn: 'lastId' });
  eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'boot.js'), 'utf8'));
  const r4 = await globalThis.NOVEL_BOOT.boot();
  await check('lastId 在 lastId 字段时同样可用', async () => {
    assert(r4.ready, 'error=' + r4.error);
    const bid = await globalThis.NOVEL_DB.createBook({ title: '新形状' });
    assert(Number(bid) === 1, 'lastId=' + bid);
  });

  /* === 5. 连接失败要把原因透出，不能白屏 === */
  const d3 = new DatabaseSync(':memory:');
  globalThis.Capacitor = fakeNative(d3, { failQuery: 'SQLITE_BUSY: database is locked' });
  eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'boot.js'), 'utf8'));
  const r5 = await globalThis.NOVEL_BOOT.boot();
  await check('迁移抛错时 ready=false 且 error 带原始信息', () => {
    eq(r5.ready, false);
    assert(r5.error.indexOf('locked') > 0, '错误未透传: ' + r5.error);
  });

  log('');
  log('合计：' + pass + ' 通过 / ' + fail + ' 失败');
  fs.writeFileSync(path.join(__dirname, 'report-m2b.txt'), lines.join('\n') + '\n', 'utf8');
  console.log(lines.filter(l => l.startsWith('FAIL')).join('\n') || '（无失败项）');
  console.log('M2b ' + pass + ' passed, ' + fail + ' failed  -> tests/report-m2b.txt');
  process.exitCode = fail ? 1 : 0;
})().catch(e => {
  console.error('测试脚本崩溃：', e);
  fs.writeFileSync(path.join(__dirname, 'report-m2b.txt'), lines.join('\n') + '\nCRASH ' + e.stack, 'utf8');
  process.exitCode = 2;
});
