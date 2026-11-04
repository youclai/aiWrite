/* ai_contract_empty.test.cjs —— 「AI 执行没有报错但没有内容」全量修复的电脑侧自验（2026-11-04）
 * 覆盖五处改动的契约与回归：
 *   ① prompt.js 输出契约：不再教模型回空标签，改为"标签内必须非空 / 无改动则逐字回显选段"
 *   ② clean.js：全角括号与 < /正文> 变体的确定性提取、空内层不锁死、残壳剔除、diagnose/headSnippet
 *   ③ session.js：产出正文却拿到空结果 → finishJob(failed) + 可重试异常 + raw_head 落库；
 *      allowEmpty（摘要/问答）与用户中途停止仍按原约定放行
 *   ④ schema/db：v8 迁移新增 ai_jobs.raw_head，finishJob 可写且未传时保留原值
 *   ⑤ aistream.js：done 却零字符（真服务）→ onEmpty 归为失败；mock 保留旧语义
 * 运行：node tests/ai_contract_empty.test.cjs   （结果写 tests/report-ai-contract-empty.txt） */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const sc = f => fs.readFileSync(path.join(ROOT, 'www/js', f), 'utf8');
const NL = '\n';
const FULL_LT = '\uff1c', FULL_GT = '\uff1e';
const G = globalThis;

let pass = 0, fail = 0;
const lines = [];
const log = s => lines.push(s);
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; log('  PASS ' + name); }
  else { fail++; log('  FAIL ' + name + '\n        got : ' + g + '\n        want: ' + w); }
}
function ok(name, cond) { eq(name, !!cond, true); }

(async () => {
  ['schema', 'db', 'clean', 'providers', 'prompt', 'consistency', 'aistream', 'util', 'adopt', 'session']
    .forEach(f => new Function(sc(f + '.js'))(G));
  const CLEAN = G.NOVEL_CLEAN, PR = G.NOVEL_PROMPT, DB = G.NOVEL_DB;

  /* ---------- ① prompt：输出契约不再诱导空回包 ---------- */
  log('== ① prompt.js 输出契约 ==');
  const mk = kind => PR.build({
    selection: '原句', template: { name: kind, instruction: '做点处理', kind: kind },
    settings: { token_budget: 6000 }
  });
  {
    const polish = mk('polish').prompt, cont = mk('continue').prompt, cons = mk('consistency').prompt;
    ok('polish 仍带 [输出格式] 与标签', polish.indexOf('[输出格式]') >= 0 && polish.indexOf('<正文>') >= 0);
    ok('polish 要求标签内非空', polish.indexOf('标签内必须非空') >= 0);
    ok('polish 无改动时逐字回显选段', polish.indexOf('逐字回显') >= 0);
    ok('continue 要求至少一句实质内容', cont.indexOf('至少有一句实质内容') >= 0);
    ok('契约已不再索取空标签回包（无"也要输出 <正文></正文>"）', polish.indexOf('也要输出') < 0 && cont.indexOf('也要输出') < 0);
    ok('一致性仍不加输出格式块', cons.indexOf('[输出格式]') < 0);
  }

  /* ---------- ② clean：容错与空块判定 ---------- */
  log('== ② clean.js 标签容错 / 空块判定 ==');
  {
    eq('规范标签取内层（回归）', CLEAN.strip('好的<正文></正文>' + NL + '<正文>夜色沉下来。</正文>还要改吗'), '夜色沉下来。');
    eq('多段内层保留（回归）', CLEAN.strip('<正文>' + NL + '第一段。' + NL + NL + '第二段。' + NL + '</正文>'), '第一段。' + NL + NL + '第二段。');
    eq('无标签回退启发式（回归）', CLEAN.strip('以下是结果：' + NL + '“正文。”'), '正文。');
    eq('全角括号变体也能确定性提取', CLEAN.strip(FULL_LT + '正文' + FULL_GT + '夜色沉下来。' + FULL_LT + '/正文' + FULL_GT), '夜色沉下来。');
    eq('合标签内嵌斜杠变体 < /正文>', CLEAN.strip('<正文>夜色沉下来。< /正文>'), '夜色沉下来。');
    eq('自闭合写法标签壳被剔净', CLEAN._internal.stripTagFragments('<正文 />夜色沉下来。< /正文>'), '夜色沉下来。');
    eq('extractPair 命中非空内层', CLEAN._internal.extractPair('<正文>真</正文>').best, '真');
    eq('extractPair 跳过空块取最长', CLEAN._internal.extractPair('说明<正文></正文>废话<正文>真正文</正文>').best, '真正文');
    eq('纯空块清洗为空串', CLEAN.strip('<正文></正文>'), '');
    eq('纯空白内层清洗为空串', CLEAN.strip('<正文>   </正文>'), '');
    eq('中文引号不当标签（不误剥正文）', CLEAN.strip('他说：“你好。”然后离开。'), '他说：“你好。”然后离开。');
    const d = CLEAN.diagnose('<正文></正文>');
    eq('diagnose 判出"只回了空标签"', d.emptyPairOnly, true);
    eq('diagnose 清洗结果为空', d.cleaned, '');
    eq('diagnose 统计原始字数', d.rawChars, 9);
    ok('diagnose 给出回包头部', d.head === '<正文></正文>');
    eq('headSnippet 压平空白并截断加省略号', CLEAN.headSnippet('a'.repeat(130) + NL + 'b'), 'a'.repeat(120) + '\u2026');
    ok('无标签时 emptyPairOnly=false（不误判成空回包）', CLEAN.diagnose('一段没有标签的正文').emptyPairOnly === false);
  }

  /* ---------- ④ schema/db：v8 raw_head ---------- */
  log('== ④ schema v8 + db.finishJob(raw_head) ==');
  const d0 = new DatabaseSync(':memory:');
  const adapter = {
    db: d0,
    all: (sql, params) => d0.prepare(sql).all(...(params || [])),
    run: (sql, params) => { const r = d0.prepare(sql).run(...(params || [])); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; },
    exec: sql => d0.exec(sql),
    close: () => d0.close()
  };
  await DB.init(adapter);
  eq('LATEST_VERSION 升到 8', G.NOVEL_SCHEMA.LATEST_VERSION, 8);
  {
    const cols = DB.all ? null : null;   // 走 raw adapter 探查列
    const info = adapter.all('PRAGMA table_info(ai_jobs)', []);
    ok('ai_jobs 有 raw_head 列', info.some(c => c.name === 'raw_head'));
    const id = await DB.startJob({ book_id: 1, chapter_id: 1, kind: 'polish', provider: 'mock', model: 'm', prompt_chars: 10 });
    await DB.finishJob(id, { status: 'ok', output_chars: 3, raw_head: 'HEAD' });
    let row = adapter.all('SELECT * FROM ai_jobs WHERE id=' + id, [])[0];
    eq('finishJob 写入 raw_head', row.raw_head, 'HEAD');
    await DB.finishJob(id, { status: 'failed', output_chars: 0, error: 'x' });
    row = adapter.all('SELECT * FROM ai_jobs WHERE id=' + id, [])[0];
    eq('未传 raw_head 时保留原值', row.raw_head, 'HEAD');
  }

  /* ---------- ③ session：空结果守卫 ---------- */
  log('== ③ session.executeAction 空结果守卫 ==');
  const DB2 = DB;
  const deps = {
    db: DB2, prompt: G.NOVEL_PROMPT, providers: G.NOVEL_PROVIDERS, stream: G.NOVEL_STREAM,
    clean: CLEAN, consistence: G.NOVEL_CONSISTENCE, secure: { getSecret: async () => 'sk' }
  };
  const bookId = await DB2.createBook({ title: '契约书', synopsis: '都市' });
  const cid = await DB2.createChapter(bookId, '第一章');
  await DB2.saveChapterBody(cid, '他走进房间。桌上有杯水。', 'create');
  const chapter = await DB2.getChapter(cid);
  const base = {
    book: { id: bookId, synopsis: '都市' }, chapter, characters: [],
    settings: await DB2.getSetting('ai_context'),
    api: { provider: 'mock', model: 'mock' },
    template: { kind: 'polish', name: '润色', instruction: '润色下文。' },
    selection: { start: 0, end: 6, text: '他走进房间。' }, before: '', after: ''
  };
  const transportOf = text => ({
    request(req, h) {
      setTimeout(() => {
        if (text) h.onLine('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }));
        h.onLine('data: [DONE]');
      }, 0);
      return { cancel() {} };
    }
  });
  {
    const res = await G.NOVEL_SESSION.executeAction(deps, Object.assign({}, base, { transport: transportOf('<正文></正文>') }));
    eq('只回空标签 → ok=false', res.ok, false);
    eq('标记为空结果异常', res.empty, true);
    ok('原因含"未返回可用正文"', /未返回可用正文/.test(res.reason || ''));
    ok('原因带原始回包摘录', /rawHead|回包摘录/.test(res.reason || '') && (res.rawHead || '').indexOf('<正文>') >= 0);
    const j = (await DB2.listJobs(50)).find(x => x.id === res.jobId);
    eq('job 记 failed', j.status, 'failed');
    eq('job 留原始回包头', j.raw_head, '<正文></正文>');
    eq('job 输出字数为 0', j.output_chars, 0);
  }
  {
    const res = await G.NOVEL_SESSION.executeAction(deps, Object.assign({}, base, { transport: transportOf('') }));
    eq('一字未回 → ok=false', res.ok, false);
    const j = (await DB2.listJobs(50)).find(x => x.id === res.jobId);
    ok('空回包也落 job（不再静默成功）', j && j.status === 'failed');
  }
  {
    const res = await G.NOVEL_SESSION.executeAction(deps, Object.assign({}, base, { allowEmpty: true, transport: transportOf('<正文></正文>') }));
    eq('allowEmpty（摘要/问答）放行空结果', res.ok, true);
    eq('allowEmpty 时正文为空串', res.cleaned, '');
  }
  {
    // 用户中途停止：无 token 也按原约定 resolve（见 m5_logic），有 token 时交付已收片段
    const neverEmit = { request() { return { cancel() {} }; } };
    const pr = G.NOVEL_SESSION.executeAction(deps, Object.assign({}, base, { transport: neverEmit }));
    pr.cancel();
    const res = await pr;
    eq('早取消仍 resolve 不悬挂', res.ok, true);
    eq('早取消 stopped=true', res.stopped, true);
  }
  {
    const res = await G.NOVEL_SESSION.executeAction(deps, Object.assign({}, base, { transport: transportOf('<正文>他步入房间，桌上搁着一杯水。</正文>') }));
    eq('正常回包仍成功', res.ok, true);
    eq('正常回包取净正文', res.cleaned, '他步入房间，桌上搁着一杯水。');
    const j = (await DB2.listJobs(50)).find(x => x.id === res.jobId);
    eq('成功也留回包头', j.raw_head, '<正文>他步入房间，桌上搁着一杯水。</正文>');
  }

  /* ---------- ⑤ aistream：done 但零字符 ---------- */
  log('== ⑤ aistream 空流守卫 ==');
  {
    const desc = G.NOVEL_PROVIDERS.describe({ provider: 'deepseek', model: 'deepseek-flash' });
    const emptyOnly = { request(req, h) { setTimeout(() => h.onLine('data: [DONE]'), 0); return { cancel() {} }; } };
    let emptyHit = 0, doneHit = 0;
    G.NOVEL_STREAM.run({
      desc, prompt: 'p', key: 'k', transport: emptyOnly,
      onDone: () => { doneHit++; }, onEmpty: () => { emptyHit++; }
    });
    await new Promise(r => setTimeout(r, 10));
    eq('真服务空流走 onEmpty', emptyHit, 1);
    eq('真服务空流不再交 onDone', doneHit, 0);

    const mockDesc = G.NOVEL_PROVIDERS.describe({ provider: 'mock' });
    let mEmpty = 0, mDone = -1;
    G.NOVEL_STREAM.run({
      desc: mockDesc, prompt: '[需要处理的内容]' + NL + '正文一句' + NL + '[别的]',
      onDone: full => { mDone = full.length; }, onEmpty: () => { mEmpty++; }
    });
    await new Promise(r => setTimeout(r, 400));
    eq('mock 空流保持旧语义（不触发 onEmpty）', mEmpty, 0);
    ok('mock 仍回调 onDone', mDone >= 0);
  }

  log('');
  log('合计 PASS=' + pass + ' FAIL=' + fail);
  fs.writeFileSync(path.join(__dirname, 'report-ai-contract-empty.txt'), lines.join(NL) + NL, 'utf8');
  process.stdout.write('DONE pass=' + pass + ' fail=' + fail + NL);
  if (fail) process.stdout.write(fs.readFileSync(path.join(__dirname, 'report-ai-contract-empty.txt'), 'utf8'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('RUNNER_ERR', e && e.stack || e); process.exit(2); });
