/* M2 数据层测试：用 node:sqlite 跑与 App 同一份 schema.js / db.js
   运行：node tests/m2_data.test.cjs   （结果同时写入 tests/report-m2.txt，规避 GBK 控制台乱码） */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

// 浏览器脚本以 globalThis 为根，直接 eval 即可在 Node 复用
for (const f of ['schema.js', 'db.js']) {
  eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', f), 'utf8'));
}
const DB = globalThis.NOVEL_DB;
const S = globalThis.NOVEL_SCHEMA;

/* ---------- 适配器 ---------- */

function makeAdapter(file, opts) {
  const d = new DatabaseSync(file);
  const brokenFts = !!(opts && opts.noFts);
  return {
    db: d,
    all: (sql, params) => d.prepare(sql).all(...(params || [])),
    run: (sql, params) => {
      const r = d.prepare(sql).run(...(params || []));
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    exec: (sql) => {
      if (brokenFts && /CREATE VIRTUAL TABLE _fts_probe/.test(sql)) {
        throw new Error('no FTS5 support (simulated)');
      }
      d.exec(sql);
    },
    close: () => d.close()
  };
}

function freshDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-m2-'));
  const file = path.join(dir, name + '.sqlite');
  const a = makeAdapter(file);
  return a;
}

/* ---------- 断言与用例 ---------- */

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

function tablesOf(a) {
  return a.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", []).map(r => r.name).sort();
}

const BODY_1 = '陈默握紧了刀，雨从檐口连续落下。他没有说话。';
const BODY_2 = '雨停了两日后再下，刀已经卷口。';

(async function run() {
  log('M2 数据层测试  ' + new Date().toISOString());
  log('node:sqlite 版本 ' + process.versions.sqlite + '   schema LATEST=v' + S.LATEST_VERSION);
  log('');

  /* === T1 全新库迁移 === */
  const a1 = freshDb('fresh');
  const info1 = await DB.init(a1);
  await check('全新库 fromVersion=0 toVersion=' + S.LATEST_VERSION, () => {
    assert(info1.fromVersion === 0, '起始版本应为 0');
    assert(info1.toVersion === S.LATEST_VERSION, '目标版本不符');
  });
  await check('user_version 已写入 ' + S.LATEST_VERSION, () => {
    eq(a1.all('PRAGMA user_version', [])[0].user_version, S.LATEST_VERSION);
  });
  await check('十张业务表全部建出', () => {
    const need = ['books', 'chapters', 'characters', 'templates', 'settings', 'snapshots', 'ai_jobs',
                  'consistency_issues', 'plot_threads', 'timeline_events', S.FTS_TABLE];
    const have = tablesOf(a1);
    need.forEach(t => assert(have.includes(t), '缺表 ' + t));
  });
  await check('内置模板 6 个 + v2 摘要模板 = 7', async () => {
    const t = await DB.listTemplates();
    eq(t.length, 7, '模板数');
    assert(t.some(x => x.kind === 'summary'), '缺 summary 模板');
    assert(t.every(x => x.is_builtin === 1), '内置标记丢失');
  });
  await check('FTS 能探到 trigram（中文子串可检索）', () => eq(info1.ftsMode, 'trigram'));

  /* === T2 FTS 触发器同步 === */
  const bookId = await DB.createBook({ title: '测试书', author: '某人', synopsis: '简介', style_note: '短句为主' });
  const chId = await DB.createChapter(bookId, '第一章');
  await DB.saveChapterBody(chId, BODY_1, 'manual');
  await check('四字词走 FTS 并即时命中', async () => {
    const r = await DB.search(bookId, '握紧了刀');
    eq(r.length, 1); eq(r[0].engine, 'trigram');
  });
  await check('两字人名自动降到 LIKE 但仍能命中', async () => {
    const r = await DB.search(bookId, '陈默');
    eq(r.length, 1); eq(r[0].engine, 'like');
  });
  await check('含双引号的查询不报错', async () => {
    const r = await DB.search(bookId, '他说"刀"');
    eq(r.length, 0);
  });
  await check('改正文后旧词不再命中（触发器 delete+insert 生效）', async () => {
    await DB.saveChapterBody(chId, BODY_2, 'ai_adopt');
    eq((await DB.search(bookId, '握紧了刀')).length, 0);
    eq((await DB.search(bookId, '雨从檐口')).length, 0);
    eq((await DB.search(bookId, '雨停了两日')).length, 1);
  });
  await check('删章后 FTS 不残留', async () => {
    const tmp = await DB.createChapter(bookId, '临时');
    await DB.saveChapterBody(tmp, '独此一处的关键词唰唰唰唰', 'manual');
    eq((await DB.search(bookId, '关键词唰唰唰')).length, 1);
    await DB.deleteChapter(tmp);
    eq((await DB.search(bookId, '关键词唰唰唰')).length, 0);
  });

  /* === T3 快照与回滚（硬约束） === */
  await check('正文未变化不产生快照', async () => {
    const before = (await DB.listSnapshots(chId)).length;
    await DB.saveChapterBody(chId, BODY_2, 'manual');
    eq((await DB.listSnapshots(chId)).length, before, '不该新增快照');
  });
  const snaps = await DB.listSnapshots(chId);
  await check('覆盖正文前自动存整章原文', async () => {
    assert(snaps.length >= 1, '应有快照');
    eq(snaps[0].body, undefined);            // 列表不返回正文，避免整库读出
    const one = await DB.getSnapshot(snaps[0].id);
    eq(one.body, BODY_1, '快照内容应为覆盖前的原文');
    eq(one.reason, 'ai_adopt');
  });
  await check('一键回滚找回原文，且回滚自身也可回滚', async () => {
    await DB.rollback(snaps[0].id);
    eq((await DB.getChapter(chId)).body, BODY_1);
    assert((await DB.listSnapshots(chId)).length === snaps.length + 1, '回滚前又存了一份当前正文');
  });

  /* === T4 字数 === */
  await check('字数=非空白字符数', () => {
    eq(DB.countWords('你好 世界\nabc'), 7);
    eq(DB.countWords('   \n\t '), 0);
    eq(DB.countWords(''), 0);
  });
  await check('保存正文时 word_count 同步', async () => {
    await DB.saveChapterBody(chId, '三个字的短句', 'manual');
    eq((await DB.getChapter(chId)).word_count, 6);
  });

  /* === T5 章节排序 === */
  const c2 = await DB.createChapter(bookId, '第二章');
  const c3 = await DB.createChapter(bookId, '第三章');
  await check('新建章节 idx 递增', async () => {
    eq((await DB.listChapters(bookId)).map(c => c.title), ['第一章', '第二章', '第三章']);
  });
  await check('拖拽重排生效', async () => {
    await DB.reorderChapters(bookId, [c3, chId, c2]);
    eq((await DB.listChapters(bookId)).map(c => c.id), [c3, chId, c2]);
  });

  /* === T6 角色卡 === */
  const cid = await DB.saveCharacter(bookId, { name: '陈默', role: '主角', aliases: ['老陈', '陈哥'],
    personality: '寡言', speech_style: '短句', taboos: '绝不说对不起', background: '猎户出身' });
  await check('aliases JSON 往返', async () => {
    const c = (await DB.listCharacters(bookId))[0];
    eq(JSON.parse(c.aliases), ['老陈', '陈哥']);
    eq(c.taboos, '绝不说对不起');
  });
  await check('更新角色卡不覆写 created_at 且不新增行', async () => {
    const before = (await DB.listCharacters(bookId))[0].created_at;
    await DB.saveCharacter(bookId, { name: '陈默', role: '主角', aliases: ['老陈'], personality: '沉默寡言',
      speech_style: '短句', taboos: '', background: '' }, cid);
    const after = (await DB.listCharacters(bookId))[0];
    eq(after.created_at, before, 'created_at 被覆写了');
    eq(after.name, '陈默');
  });

  /* === T7 设定与开关 === */
  await check('默认值生效', async () => {
    const ctx = await DB.getSetting('ai_context');
    eq(ctx.use_summary, false); eq(ctx.inject_taboos, true); eq(ctx.token_budget, 6000);
  });
  await check('覆盖后新增键仍自动补齐', async () => {
    await DB.setSetting('ai_context', { use_summary: true });
    const ctx = await DB.getSetting('ai_context');
    eq(ctx.use_summary, true); eq(ctx.inject_taboos, true);
  });
  await check('auto_adopt 写死 false（存 true 也被强制改回）', async () => {
    await DB.setSetting('ai_context', { use_summary: true, auto_adopt: true });
    eq((await DB.getSetting('ai_context')).auto_adopt, false);
  });

  /* === T8 伏笔与时间线 === */
  const t1 = await DB.saveThread(bookId, { title: '断刀', planted_chapter_id: chId, status: 'open' });
  await DB.saveThread(bookId, { title: '雨夜来人', planted_chapter_id: chId, status: 'open' });
  const t3 = await DB.saveThread(bookId, { title: '旧债', planted_chapter_id: chId, status: 'open' });
  await DB.saveThread(bookId, { title: '旧债', planted_chapter_id: chId, status: 'paid', payoff_chapter_id: c2 }, t3);
  await check('筛"未回收"剩 2 条', async () => {
    eq((await DB.listThreads(bookId, 'open')).length, 2);
    eq((await DB.listThreads(bookId)).length, 3, '全部应为 3 条');
  });
  await DB.saveEvent(bookId, { title: '离乡', sort_key: '0001', when_label: '三年冬', chapter_id: chId });
  await DB.saveEvent(bookId, { title: '重逢', sort_key: '0003', when_label: '五年后', chapter_id: c2 });
  await DB.saveEvent(bookId, { title: '结绳', sort_key: '0002', when_label: '四年春', chapter_id: c3 });
  await check('时间线按 sort_key 排序', async () => {
    eq((await DB.listEvents(bookId)).map(e => e.title), ['离乡', '结绳', '重逢']);
  });

  /* === T9 一致性报告 === */
  const jobId = await DB.startJob({ book_id: bookId, chapter_id: chId, kind: 'consistency', provider: 'mock', model: 'mock-1', prompt_chars: 120 });
  await DB.addIssues(bookId, chId, jobId, [
    { quote: '陈默说："对不起。"', type: 'OOC', problem: '违反禁忌：绝不说对不起', suggestion: '改为沉默或动作描写' },
    { quote: '老陈抬起头', type: '称呼', problem: '同段内称呼在"陈默/老陈"间跳变', suggestion: '统一为陈默' }
  ]);
  await DB.finishJob(jobId, { status: 'ok', output_chars: 260 });
  await check('条目入库并可筛状态', async () => {
    eq((await DB.listIssues(bookId, 'open')).length, 2);
    await DB.setIssueStatus((await DB.listIssues(bookId))[0].id, 'fixed');
    eq((await DB.listIssues(bookId, 'open')).length, 1);
    eq((await DB.listIssues(bookId)).length, 2);
  });
  await check('引用原文片段可定位（quote 完整保存）', async () => {
    const it = (await DB.listIssues(bookId, 'open'))[0];
    assert(it.quote.length > 0 && it.type === 'OOC', 'quote/type 不符');
  });
  await check('失败任务落 ai_jobs 且计入统计', async () => {
    const j = await DB.startJob({ book_id: bookId, kind: 'polish', provider: 'openai_chat', model: 'x' });
    await DB.finishJob(j, { status: 'failed', error: 'HTTP 500' });
    eq((await DB.stats(bookId))[0].failed_jobs, 1);
    eq((await DB.listJobs(5))[0].status, 'failed', '最新任务应排最前');
  });

  /* === T10 统计与级联 === */
  await check('书架列表带章节数与总字数', async () => {
    const b = (await DB.listBooks()).find(x => x.id === bookId);
    eq(b.chapter_count, 3); assert(b.total_words > 0, '总字数为 0');
  });
  await check('stats 汇总一致', async () => {
    const s = (await DB.stats(bookId))[0];
    eq(s.chapters, 3); eq(s.open_threads, 2); eq(s.open_issues, 1); eq(s.characters, 1);
  });
  await check('删书级联清掉章节与快照', async () => {
    const tmpBook = await DB.createBook({ title: '待删书' });
    const tc = await DB.createChapter(tmpBook, '唯一一章');
    await DB.saveChapterBody(tc, '一段会被连带清掉的正文', 'manual');
    assert((await DB.listSnapshots(tc)).length === 0, '首次写入不该有快照');
    await DB.saveChapterBody(tc, '改了第二次才有快照', 'manual');
    assert((await DB.listSnapshots(tc)).length === 1, '前置条件：应有 1 份快照');
    await DB.deleteBook(tmpBook);
    eq(a1.all('SELECT COUNT(*) AS n FROM chapters WHERE book_id=?', [tmpBook])[0].n, 0);
    eq(a1.all('SELECT COUNT(*) AS n FROM snapshots WHERE book_id=?', [tmpBook])[0].n, 0);
  });
  a1.close();

  /* === T11 在"已有 v1 库副本"上测升级路径 === */
  const dirV1 = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v1-'));
  const v1file = path.join(dirV1, 'legacy.sqlite');
  {
    const legacy = makeAdapter(v1file);
    S.MIGRATIONS[0].up.forEach(st => { if (st.sql) legacy.exec(st.sql); });
    legacy.exec('PRAGMA user_version = 1');
    legacy.run("INSERT INTO books (title,created_at,updated_at) VALUES (?,?,?)", ['旧版就有的书', 1, 1]);
    legacy.run('INSERT INTO chapters (book_id,idx,title,body,word_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      [1, 1, '旧章节', '只有旧表数据的库', 8, 1, 1]);
    legacy.close();
  }
  const a2 = makeAdapter(v1file);
  const info2 = await DB.init(a2);
  const legacyBookId = (await DB.listBooks())[0].id;
  await check('v1 库升级：fromVersion=1', () => eq(info2.fromVersion, 1));
  await check('升级后新表出现', () => assert(tablesOf(a2).includes('plot_threads'), '缺 plot_threads'));
  await check('旧数据一条不丢', async () => {
    const bs = await DB.listBooks();
    eq(bs.length, 1); eq(bs[0].title, '旧版就有的书');
    eq((await DB.listChapters(bs[0].id))[0].title, '旧章节');
  });
  await check('旧库补建 FTS 且可检索', async () => {
    eq(info2.ftsMode, 'trigram');
    eq((await DB.search(legacyBookId, '旧表数据')).length, 1);
  });
  await check('重复 init 幂等（不重复迁移、不重复建 FTS）', async () => {
    const before = tablesOf(a2).length;
    const again = await DB.init(makeAdapter(v1file));
    eq(again.fromVersion, S.LATEST_VERSION, '应识别为已是最新');
    eq(tablesOf(a2).length, before);
    eq((await DB.listBooks()).length, 1, '数据没被重复迁移弄乱');
  });
  a2.close();

  /* === T12 FTS5 缺失时降级 LIKE === */
  const dirNf = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-nofft-'));
  const nfFile = path.join(dirNf, 'nofft.sqlite');
  const a3 = makeAdapter(nfFile, { noFts: true });   // 两个探测都失败 → 整库 LIKE
  const info3 = await DB.init(a3);
  await check('探测失败 → ftsMode=like', () => eq(info3.ftsMode, 'like'));
  await check('降级后表照样建、写入不受影响', async () => {
    assert(!tablesOf(a3).includes(S.FTS_TABLE), '不该有 FTS 表');
    const b = await DB.createBook({ title: '降级书' });
    const c = await DB.createChapter(b, '第一章');
    await DB.saveChapterBody(c, '这段正文里的关键词叫做琥珀', 'manual');
    eq((await DB.getChapter(c)).word_count > 0, true);
  });
  await check('LIKE 检索仍出结果并标注 engine=like', async () => {
    const b = (await DB.listBooks()).find(x => x.title === '降级书');
    const r = await DB.search(b.id, '琥珀');
    eq(r.length, 1); eq(r[0].engine, 'like');
  });
  a3.close();

  log('');
  log('合计：' + pass + ' 通过 / ' + fail + ' 失败');
  fs.writeFileSync(path.join(__dirname, 'report-m2.txt'), lines.join('\n') + '\n', 'utf8');
  console.log(lines.filter(l => l.startsWith('FAIL')).join('\n') || '（无失败项）');
  console.log('M2 ' + pass + ' passed, ' + fail + ' failed  -> tests/report-m2.txt');
  process.exitCode = fail ? 1 : 0;
})().catch(e => {
  console.error('测试脚本崩溃：', e);
  fs.writeFileSync(path.join(__dirname, 'report-m2.txt'), lines.join('\n') + '\nCRASH ' + e.stack, 'utf8');
  process.exitCode = 2;
});
