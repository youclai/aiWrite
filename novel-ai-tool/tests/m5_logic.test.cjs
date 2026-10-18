/* m5_logic.test.cjs —— M5 可电脑侧自验的纯逻辑 + 流式停止（Node + node:sqlite，不上真机）
 * 覆盖：
 *   1) session 停止：中途 cancel 交付已收片段并可采纳、绝不悬挂；早于流建立的取消也生效；job 记 stopped-by-user
 *   2) 上下文开关（F20–F24）：use_summary / inject_prev_summary / inject_taboos 对 prompt 的有无影响
 *   3) 角色卡别名命中：按 name/aliases 频次命中并注入性格/禁忌
 *   4) 时间线（F34）：按 sort_key 稳定排序；且“不进 prompt”不变式
 *   5) 全文检索（F40）：两字/多字查询在 LIKE/FTS 下都能命中本章
 * 运行：node tests/m5_logic.test.cjs
 */
const { execSync } = require('node:child_process');
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
const ok = (name, cond) => eq(name, !!cond, true);

const G = globalThis;
(async () => {
  ['schema', 'db', 'clean', 'providers', 'prompt', 'consistency', 'aistream', 'util', 'adopt', 'session']
    .forEach(f => new Function(sc(f + '.js'))(G));
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(':memory:');
  const adapter = {
    db: d,
    all: (sql, params) => d.prepare(sql).all(...(params || [])),
    run: (sql, params) => { const r = d.prepare(sql).run(...(params || [])); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; },
    exec: (sql) => d.exec(sql),
    close: () => d.close()
  };
  await G.NOVEL_DB.init(adapter);
  const DB = G.NOVEL_DB;
  const deps = {
    db: DB, prompt: G.NOVEL_PROMPT, providers: G.NOVEL_PROVIDERS, stream: G.NOVEL_STREAM,
    clean: G.NOVEL_CLEAN, consistence: G.NOVEL_CONSISTENCE, secure: { getSecret: async () => 'sk' }
  };
  const bookId = await DB.createBook({ title: '夜航', synopsis: '都市夜行设定', style_note: '冷硬' });
  const chapId = await DB.createChapter(bookId);
  const chapter = await DB.getChapter(chapId);
  const tpl = { name: '润色', kind: 'polish', instruction: '让文字更凝练' };
  const baseArgs = {
    book: { id: bookId, synopsis: '都市夜行设定', style_note: '冷硬' }, chapter, characters: [],
    settings: await DB.getSetting('ai_context'), api: { provider: 'mock', model: 'mock' }, template: tpl,
    selection: { start: 0, end: 4, text: '夜色沉' }, before: '', after: ''
  };

  /* ---------- 1) 流式停止 ---------- */
  log('== session 停止（cancel handle）==');
  {
    // 只吐一个 delta、永不 [DONE] 的传输：不取消就会悬挂，用它验证 cancel 交付已收片段
    const oneShot = {
      request(req, h) {
        setTimeout(() => h.onLine('data: ' + JSON.stringify({ choices: [{ delta: { content: '夜色沉' } }] })), 0);
        return { cancel() {} };
      }
    };
    const pr = G.NOVEL_SESSION.executeAction(deps, Object.assign({}, baseArgs, {
      transport: oneShot,
      onDelta() { pr.cancel(); }         // 收到首个片段即停止
    }));
    const res = await pr;
    ok('中途停止：promise 正常 resolve 不悬挂', res && res.ok === true);
    eq('停止标志 stopped=true', res.stopped, true);
    eq('已收片段可作为结果采纳', res.cleaned, '夜色沉');
    ok('返回 cancel 是函数', typeof pr.cancel === 'function');
    const jobs = await DB.listJobs(50);
    const j = jobs.find(x => x.id === res.jobId);
    ok('job 记 ok 且标 stopped-by-user', j && j.status === 'ok' && j.error === 'stopped-by-user');
  }
  {
    // 早于流建立的取消：cancelFn 尚未生成时记意图，建流即刻生效（结果空但不悬挂）
    const neverEmit = { request() { return { cancel() {} }; } };
    const pr = G.NOVEL_SESSION.executeAction(deps, Object.assign({}, baseArgs, { transport: neverEmit }));
    pr.cancel();                          // 立即取消（此时流可能还没建）
    const res = await pr;                 // 若没兜住早取消，这里会永久 await
    ok('早取消也能 resolve（不悬挂）', res && res.ok === true);
    eq('早取消 stopped=true', res.stopped, true);
  }

  /* ---------- 2) 上下文开关 ---------- */
  log('== 上下文开关（F20–F24）==');
  const cctx = {
    book: { synopsis: 'S', style_note: 'W' }, chapterSummary: '本章摘要甲', prevSummary: '前情摘要乙',
    selection: '选段', beforeText: 'b', afterText: 'a', matchText: '选段',
    characters: [], template: tpl
  };
  {
    const on = G.NOVEL_PROMPT.build(Object.assign({}, cctx, { settings: { use_summary: true } }));
    const off = G.NOVEL_PROMPT.build(Object.assign({}, cctx, { settings: { use_summary: false } }));
    ok('use_summary=true 注入本章摘要', /本章摘要：本章摘要甲/.test(on.prompt));
    ok('use_summary=false 不注入本章摘要', !/本章摘要/.test(off.prompt));
  }
  {
    const on = G.NOVEL_PROMPT.build(Object.assign({}, cctx, { settings: { inject_prev_summary: true } }));
    const off = G.NOVEL_PROMPT.build(Object.assign({}, cctx, { settings: { inject_prev_summary: false } }));
    ok('inject_prev_summary=true 注入上一章摘要', /上一章摘要：前情摘要乙/.test(on.prompt));
    ok('inject_prev_summary=false 不注入上一章摘要', !/上一章摘要/.test(off.prompt));
  }

  /* ---------- 3) 角色卡命中 + 禁忌注入 ---------- */
  log('== 角色卡命中 / inject_taboos ==');
  const chars = [
    { name: '林墨', role: '主角', aliases: ['小墨', '阿墨'], personality: '沉默寡言', speech_style: '短句', taboos: '忌提旧伤' },
    { name: '赵晴', role: '配角', aliases: [], personality: '开朗', speech_style: '', taboos: '忌吵闹' }
  ];
  {
    // matchText 出现“小墨”两次 → 命中林墨（别名），赵晴未出现不命中
    const built = G.NOVEL_PROMPT.build({
      book: { synopsis: 'S' }, selection: '小墨走了', beforeText: '小墨坐下', afterText: '', matchText: '小墨走了，小墨坐下。',
      characters: chars, template: tpl, settings: { inject_taboos: true }
    });
    eq('命中角色=林墨', built.matchedCharacters, ['林墨']);
    ok('prompt 注入性格', /沉默寡言/.test(built.prompt));
    ok('inject_taboos=true 注入禁忌', /忌提旧伤/.test(built.prompt));
    const notaboo = G.NOVEL_PROMPT.build({
      book: {}, selection: '小墨', matchText: '小墨', characters: chars, template: tpl, settings: { inject_taboos: false }
    });
    ok('inject_taboos=false 不注入禁忌', !/忌提旧伤/.test(notaboo.prompt) && /沉默寡言/.test(notaboo.prompt));
  }

  /* ---------- 4) 时间线排序 + 不进 prompt ---------- */
  log('== 时间线（F34）==');
  {
    const evBook = await DB.createBook({ title: '时间线书' });
    // 乱序插入，靠 sort_key 排；同 sort_key 靠 id 稳定
    await DB.saveEvent(evBook, { title: '丙事', sort_key: '2026-03-01', when_label: '三月', detail: 'MARK_C_IN_PROMPT' });
    await DB.saveEvent(evBook, { title: '甲事', sort_key: '2026-01-01', when_label: '一月', detail: '' });
    await DB.saveEvent(evBook, { title: '乙-2', sort_key: '2026-02-01', when_label: '二月', detail: '' });
    await DB.saveEvent(evBook, { title: '乙-1', sort_key: '2026-02-01', when_label: '二月', detail: '' });
    const evs = await DB.listEvents(evBook);
    eq('按 sort_key 排序，同 key 按 id 稳定', evs.map(e => e.title), ['甲事', '乙-2', '乙-1', '丙事']);
    ok('同 sort_key 按插入序(id)稳定（乙-2 先插）', evs[1].title === '乙-2');
    // 不进 prompt：时间线里的独有标记绝不出现在组装好的 prompt
    const built = G.NOVEL_PROMPT.build({ book: { synopsis: 'S' }, selection: 'x', matchText: 'x', characters: [], template: tpl, settings: {} });
    ok('时间线内容不进 prompt', built.prompt.indexOf('MARK_C_IN_PROMPT') < 0);
  }

  /* ---------- 5) 全文检索 ---------- */
  log('== 全文检索（F40）==');
  {
    const sBook = await DB.createBook({ title: '检索书' });
    const c1 = await DB.createChapter(sBook, '第一章');
    const c2 = await DB.createChapter(sBook, '第二章');
    await DB.saveChapterBody(c1, '林小满在雨夜里等车。', 'edit');
    await DB.saveChapterBody(c2, '另一段无关文字。', 'edit');
    const hits = await DB.search(sBook, '林小满');
    ok('命中含目标词的章', hits.some(h => String(h.id) === String(c1)));
    ok('未命中无关章', !hits.some(h => String(h.id) === String(c2)));
    ok('结果带引擎标记', hits.length === 0 || (hits[0].engine === 'like' || hits[0].engine === 'trigram' || hits[0].engine === 'fts5'));
    const none = await DB.search(sBook, 'ZZZ不存在');
    eq('无关词零命中', none.length, 0);
  }

  log('');
  log(`合计：${pass} 通过 / ${fail} 失败`);
  fs.writeFileSync(path.join(__dirname, 'report-m5-logic.txt'), out.join('\n'), 'utf8');
  try { execSync('chcp 65001 >nul 2>&1', { stdio: 'ignore' }); } catch (e) {}
  process.stdout.write(out.join('\n') + '\n');
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('测试自身异常:', e); process.exitCode = 2; });
