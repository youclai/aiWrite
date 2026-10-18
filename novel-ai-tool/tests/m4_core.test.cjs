/* m4_core.test.cjs —— M4 逻辑层 + 写作主链路无头端到端自检（Node 侧，不上真机）
 * 覆盖：util（防抖/HTML转义/选区钳制）、adopt（F07 三选）、session（F05–F07/F11 编排）
 * 端到端：建书→建章→写正文→mock 润色→预览→采纳(写回触发快照)→回滚复原
 * 运行：node tests/m3 同一套 Node；本文件 node tests/m4_core.test.cjs
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
const ok = (name, cond, msg) => eq(name, !!cond, true);
if (process.env.DBG) process.on('unhandledRejection', e => { console.error('UNHANDLED:', e); });

// 组装 deps：真实 db(node:sqlite) + 纯逻辑模块 + secure 假实现
const G = globalThis;
(async () => {
  execSync('node --version', { cwd: ROOT });
  new Function(sc('schema.js'))(G);
  new Function(sc('db.js'))(G);
  ['clean', 'providers', 'prompt', 'consistency', 'aistream', 'util', 'adopt', 'session']
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
  const secureStub = { getSecret: async k => (k === 'api_key' ? 'sk-test' : ''), setSecret: async () => true };
  const deps = {
    db: DB, prompt: G.NOVEL_PROMPT, providers: G.NOVEL_PROVIDERS, stream: G.NOVEL_STREAM,
    clean: G.NOVEL_CLEAN, consistence: G.NOVEL_CONSISTENCE, secure: secureStub
  };

  /* ---------- util.js ---------- */
  log('== NOVEL_UTIL 工具 ==');
  eq('clampRange 越界收敛', G.NOVEL_UTIL.clampRange(-5, 999, 100), { start: 0, end: 100, valid: true });
  eq('clampRange 倒置对调', G.NOVEL_UTIL.clampRange(30, 10, 100), { start: 10, end: 30, valid: true });
  eq('clampRange 零宽无效', G.NOVEL_UTIL.clampRange(5, 5, 100), { start: 5, end: 5, valid: false });
  eq('escapeHtml 转义', G.NOVEL_UTIL.escapeHtml('<a b="c">&\''), '&lt;a b=&quot;c&quot;&gt;&amp;&#39;');
  {
    const U = G.NOVEL_UTIL, O = U.MARK_OPEN, C = U.MARK_CLOSE;
    eq('markSelection 包裹选区', U.markSelection('夜色沉沉。他进门。', 5, 8), '夜色沉沉。' + O + '他进门' + C + '。');
    eq('markSelection 零宽不加标记', U.markSelection('abc', 2, 2), 'abc');
    eq('stripMarkers 去标记还原', U.stripMarkers(U.markSelection('abcde', 1, 3)), 'abcde');
    // extractMarked：base=去标记全文，start/end 为内层文字在 base 中偏移
    const mk = U.extractMarked('abc' + O + 'DE' + C + 'fg');
    eq('extractMarked base', mk && mk.base, 'abcDEfg');
    eq('extractMarked text', mk && mk.text, 'DE');
    eq('extractMarked 偏移', mk && [mk.start, mk.end], [3, 5]);
    eq('extractMarked 无标记返回 null', U.extractMarked('纯正文无标记'), null);
    // mapToClean：带标记串上的光标坐标 → 干净串坐标（'ab'+O+'cd'+C 干净为 'abcd'）
    eq('mapToClean 跳过标记符', U.mapToClean('ab' + O + 'cd' + C, 4, 5), { start: 3, end: 4 });
  }
  {
    let clock = { id: null, setTimeout(fn, ms) { this.fn = fn; this.id = ms; }, clearTimeout() { this.id = null; } };
    let hits = 0;
    const d = G.NOVEL_UTIL.debounce(() => hits++, 300, clock);
    d(); d(); d();
    eq('debounce 连点仅排队一次(未触发)', [hits, clock.id], [0, 300]);
    clock.fn();                    // 手动到点
    eq('debounce 到点执行一次', hits, 1);
  }

  /* ---------- adopt.js（F07 三选）---------- */
  log('== NOVEL_ADOPT 采纳应用 ==');
  const body = '夜色沉下来，灯一盏盏亮了。';
  {
    const r = G.NOVEL_ADOPT.applyResult('replace', body, 0, 6, '暮色四合。');
    eq('replace 替换选区', r.newBody, '暮色四合。灯一盏盏亮了。');
    ok('replace changed', r.changed);
  }
  {
    const r = G.NOVEL_ADOPT.applyResult('insert', body, 6, 6, '插入句');
    ok('insert 保留原文', r.newBody.startsWith('夜色沉下来') && r.newBody.includes('插入句'));
  }
  {
    const r = G.NOVEL_ADOPT.applyResult('discard', body, 0, 6, '任意');
    eq('discard 不改正文', [r.changed, r.newBody], [false, body]);
  }
  ok('MODES 三选齐全', G.NOVEL_ADOPT.MODES.length === 3);

  /* ---------- session.executeAction：mock 润色 ---------- */
  log('== NOVEL_SESSION 写作引擎（mock 端到端）==');
  const bookId = await DB.createBook({ title: '测试书', synopsis: '都市夜行', style_note: '冷硬' });
  const chapId = await DB.createChapter(bookId);
  const seed = '他走进房间。桌上有杯水。';
  await DB.saveChapterBody(chapId, seed, 'create');

  const tpl = { name: '润色', instruction: '让文字更凝练有画面感', kind: 'polish' };
  let deltas = 0;
  const res = await G.NOVEL_SESSION.executeAction(deps, {
    book: { id: bookId, synopsis: '都市夜行', style_note: '冷硬' },
    chapter: await DB.getChapter(chapId),
    characters: [],
    settings: await DB.getSetting('ai_context'),
    api: { provider: 'mock', model: 'mock' },
    template: tpl,
    selection: { start: 0, end: 6, text: seed.slice(0, 6) },
    before: '', after: '',
    onDelta: () => { deltas++; }
  });
  ok('executeAction 成功', res.ok, res.reason);
  ok('返回清洗后结果(非空)', res.cleaned && res.cleaned.length > 0);
  ok('结果去掉了模型客套(不以其开头)', !/^好的[，,]/.test(res.cleaned));
  ok('走了 onDelta 分片', deltas >= 1);
  ok('prompt 含选段', /他走进房间/.test(res.prompt));
  ok('prompt 含指令', /\[指令\]/.test(res.prompt));
  {
    const jobs = await DB.listJobs(50);
    ok('ai_jobs 记一条 ok', jobs.some(j => j.id === res.jobId && j.status === 'ok' && j.kind === 'polish'));
  }

  /* ---------- 采纳→快照→回滚 闭环（模拟 UI 写回）---------- */
  log('== 采纳写回 → 快照 → 回滚 ==');
  const clamped = G.NOVEL_UTIL.clampRange(res.selection.start, res.selection.end, seed.length);
  // mock 会原样回显选段；用 insert 模式必然改动正文，以验证快照/回滚链路
  const applied = G.NOVEL_ADOPT.applyResult('insert', seed, clamped.end, clamped.end, res.cleaned || '（补充一句）');
  ok('applyResult changed', applied.changed);
  await DB.saveChapterBody(chapId, applied.newBody, 'adopt');       // 覆盖旧正文→自动快照
  const chapAfterAdopt = await DB.getChapter(chapId);
  eq('正文已更新为采纳结果', chapAfterAdopt.body, applied.newBody);
  let snaps = await DB.listSnapshots(chapId);
  ok('生成一条快照', snaps.length >= 1);
  eq('快照 reason', snaps[0].reason, 'adopt');
  // 回滚到采纳前
  await DB.rollback(snaps[0].id);
  const rolled = await DB.getChapter(chapId);
  eq('回滚复原到 seed', rolled.body, seed);
  ok('回滚自身也留痕(可再回滚)', (await DB.listSnapshots(chapId)).length >= 2);

  /* ---------- session 失败兜底：传输报错 ---------- */
  log('== executeAction 失败兜底 ==');
  const errTransport = {
    request: function (req, h) {
      setTimeout(function () { h.onError(new Error('网络中断')); }, 0);
      return { cancel: function () {} };
    }
  };
  const bad = await G.NOVEL_SESSION.executeAction(deps, {
    book: { id: bookId }, chapter: await DB.getChapter(chapId), characters: [],
    settings: await DB.getSetting('ai_context'),
    api: { provider: 'mock' }, template: tpl,
    selection: { start: 0, end: 2, text: '他走' },
    transport: errTransport
  });
  ok('失败不抛异常，返回 ok:false', bad && bad.ok === false, bad && bad.reason);
  ok('给出可读原因', bad && typeof bad.reason === 'string' && bad.reason.length > 0);

  /* ---------- runConsistency：解析+落库 ---------- */
  log('== runConsistency 一致性 ==');
  // 用一个直接返回 JSON 的假传输，验证 parse+addIssues 串通
  const cjson = '[{"quote":"他走进房间","type":"角色","problem":"与设定不符","suggestion":"改名"}]';
  function jsonTransport() {
    return {
      request: function (req, h) {
        const evs = ['data: {"choices":[{"delta":{"content":' + JSON.stringify(cjson) + '}}]}', 'data: [DONE]'];
        let stopped = false, i = 0;
        const tick = () => { if (stopped) return; if (i < evs.length) { h.onLine(evs[i++]); setTimeout(tick, 0); } };
        setTimeout(tick, 0);
        return { cancel() { stopped = true; } };
      }
    };
  }
  const cres = await G.NOVEL_SESSION.runConsistency(deps, {
    book: { id: bookId }, chapter: await DB.getChapter(chapId), characters: [],
    settings: await DB.getSetting('ai_context'),
    api: { provider: 'mock' }, template: { name: '一致性检查', kind: 'consistency', instruction: '检查矛盾' },
    selection: { start: 0, end: 0, text: '' }, transport: jsonTransport()
  });
  ok('consistency 解析出条目', cres.ok && cres.issues && cres.issues.length === 1);
  if (cres.issues && cres.issues.length) {
    eq('条目字段', cres.issues[0].type, '角色');
    const iss = await DB.listIssues(bookId, 'open');
    ok('条目已落库 open', iss.some(x => x.problem === '与设定不符'));
  }

  log('');
  log(`合计：${pass} 通过 / ${fail} 失败`);
  fs.writeFileSync(path.join(__dirname, 'report-m4-core.txt'), out.join('\n'), 'utf8');
  try { execSync('chcp 65001 >nul 2>&1', { stdio: 'ignore' }); } catch (e) {}
  process.stdout.write(out.join('\n') + '\n');
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('测试自身异常:', e); process.exitCode = 2; });
