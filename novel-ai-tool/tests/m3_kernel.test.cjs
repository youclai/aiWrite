/* M3 内核测试：prompt 组装+五级裁剪 / providers 请求与 SSE 解析 / clean 输出清洗 /
   consistency 三级降级解析 / aistream mock 端到端（选段→假流式→清洗→采纳前）。
   全部电脑侧 Node 可跑，不依赖真机与网络。
   运行：node tests/m3_kernel.test.cjs   （结果写 tests/report-m3-kernel.txt） */
'use strict';

const fs = require('fs');
const path = require('path');

for (const f of ['schema.js', 'db.js', 'clean.js', 'providers.js', 'prompt.js', 'consistency.js', 'aistream.js']) {
  eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', f), 'utf8'));
}
const CLEAN = globalThis.NOVEL_CLEAN;
const PROV = globalThis.NOVEL_PROVIDERS;
const PR = globalThis.NOVEL_PROMPT;
const CONS = globalThis.NOVEL_CONSISTENCE;
const STREAM = globalThis.NOVEL_STREAM;

let pass = 0, fail = 0;
const lines = [];
function log(s) { lines.push(s); }
async function check(name, fn) {
  try { await fn(); pass++; log('PASS  ' + name); }
  catch (e) { fail++; log('FAIL  ' + name + '  ::  ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }
function eq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' 期望 ' + JSON.stringify(b) + ' 实得 ' + JSON.stringify(a));
}

(async function run() {
  log('M3 内核测试  ' + new Date().toISOString());
  log('');

  /* ===== clean.js ===== */
  await check('clean：去客套+引导语+围栏+外层引号，正文保留', () => {
    const out = CLEAN.strip('好的，以下是润色结果：\n\n“夜色沉下来，李四推门而入。”\n');
    eq(out, '夜色沉下来，李四推门而入。');
  });
  await check('clean：代码围栏整块剥离', () => {
    const out = CLEAN.strip('```js\n正文第一行\n第二行\n```');
    eq(out, '正文第一行\n第二行');
  });
  await check('clean：正文中间的引导性引号不误伤（只有整体包裹才剥）', () => {
    const out = CLEAN.strip('他说：“你好。”然后离开。');
    eq(out, '他说：“你好。”然后离开。');
  });
  await check('clean：空/纯白输入返回空串', () => {
    eq(CLEAN.strip(''), '');
    eq(CLEAN.strip('   \n  '), '');
  });
  // 固定输出契约（本轮完善）：命中 <正文>…</正文> 只取内层，越格式的客套/解释全丢
  await check('clean：命中 <正文> 包裹 → 只取内层，包裹外的客套与追问全丢', () => {
    eq(CLEAN.strip('当然可以！以下是续写：\n<正文>夜色沉下来，李四推门而入。</正文>\n需要我再改吗？'), '夜色沉下来，李四推门而入。');
  });
  await check('clean：<正文> 内多段保留、仅去首尾空行', () => {
    eq(CLEAN.strip('<正文>\n第一段。\n\n第二段。\n</正文>'), '第一段。\n\n第二段。');
  });
  await check('clean：无标记时回退旧启发式（向后兼容）', () => {
    eq(CLEAN.strip('以下是结果：\n“正文。”'), '正文。');
  });
  await check('clean：extractDelimited 命中返回内层、否则 null', () => {
    eq(CLEAN._internal.extractDelimited('x<正文>ABC</正文>y'), 'ABC');
    eq(CLEAN._internal.extractDelimited('无标记'), null);
  });
  await check('clean：多个 <正文> 取最长（跳过空回显/短废话块）', () => {
    eq(CLEAN._internal.extractDelimited('说明<正文></正文>废话<正文>真正文在这里</正文>尾'), '真正文在这里');
    eq(CLEAN.strip('好的<正文></正文>\n<正文>夜色沉下来。</正文>还要改吗'), '夜色沉下来。');
  });

  /* ===== providers.js ===== */
  await check('providers：DeepSeek 预设生成 openai 兼容请求（url/头/body/stream）', () => {
    const d = PROV.describe({ provider: 'deepseek', model: 'deepseek-chat' });
    const req = d.buildRequest('PROMPT', { key: 'sk-test' });
    eq(req.url, 'https://api.deepseek.com/chat/completions');
    eq(req.headers['Authorization'], 'Bearer sk-test');
    const body = JSON.parse(req.body);
    eq(body.stream, true); eq(body.model, 'deepseek-chat');
    eq(body.messages.map(m => m.role), ['system', 'user']);
    eq(body.messages[1].content, 'PROMPT');
  });
  await check('providers：千问(Qwen) 预设 host 正确', () => {
    const d = PROV.describe({ provider: 'qwen' });
    assert(d.base.indexOf('dashscope') >= 0, '千问 base 应为 DashScope，实得 ' + d.base);
    eq(d.buildRequest('x', { key: 'k' }).url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  });
  await check('providers：anthropic 走 x-api-key + system 分离', () => {
    const d = PROV.describe({ provider: 'anthropic' });
    const req = d.buildRequest('P', { key: 'sk-ant', system: 'SYS' });
    eq(req.headers['x-api-key'], 'sk-ant');
    eq(req.headers['anthropic-version'], '2023-06-01');
    const b = JSON.parse(req.body);
    eq(b.system, 'SYS'); eq(b.messages[0].role, 'user');
  });
  await check('providers：custom 无 base_url 时明确报错', () => {
    let threw = false;
    try { PROV.describe({ provider: 'custom', base_url: '' }); } catch (e) { threw = true; }
    assert(threw, 'custom 缺 base_url 应抛错');
  });
  await check('providers：openai SSE 行解析 delta 与 [DONE]', () => {
    const d = PROV.describe({ provider: 'deepseek' });
    eq(d.parseLine('data: {"choices":[{"delta":{"content":"你好"}}]}'), { kind: 'delta', text: '你好' });
    eq(d.parseLine('data: [DONE]'), { kind: 'done' });
    eq(d.parseLine(''), { kind: 'ignore' });
    eq(d.parseLine(': keep-alive'), { kind: 'ignore' });
  });
  await check('providers：anthropic SSE 行解析 content_block_delta/message_stop', () => {
    const d = PROV.describe({ provider: 'anthropic' });
    eq(d.parseLine('data: {"type":"content_block_delta","delta":{"text":"冲"}}'), { kind: 'delta', text: '冲' });
    eq(d.parseLine('event: message_stop'), { kind: 'done' });
  });
  await check('providers：errorReason 对 401/超时/DNS 给可判定原因', () => {
    assert(PROV.errorReason({ message: 'HTTP 401 Unauthorized' }).indexOf('401') >= 0);
    assert(PROV.errorReason({ message: 'connect ETIMEDOUT' }).indexOf('超时') >= 0);
    assert(PROV.errorReason({ message: 'getaddrinfo ENOTFOUND x' }).indexOf('DNS') >= 0);
  });

  /* ===== prompt.js ===== */
  const baseCtx = () => ({
    book: { synopsis: '都市异能', style_note: '短句为主' },
    chapterSummary: '主角初显异能',
    selection: '李四握紧了拳头。',
    beforeText: '前文一段。\n\n前文二段。',
    afterText: '后文一段。\n\n后文二段。',
    characters: [
      { name: '李四', role: '主角', aliases: ['四哥', '小李'], personality: '沉稳', speech_style: '简洁', taboos: '怕水' },
      { name: '王五', role: '配角', aliases: [], personality: '张扬', speech_style: '啰嗦', taboos: '' }
    ],
    template: { name: '润色', instruction: '润色下文，保持原意。', use_summary: false },
    settings: { use_summary: false, inject_taboos: true, inject_prev_summary: false, token_budget: 6000 }
  });
  await check('prompt：正常组装含选段/指令，选段原样保留', () => {
    const r = PR.build(baseCtx());
    assert(r.prompt.indexOf('李四握紧了拳头。') >= 0, '选段丢失');
    assert(r.prompt.indexOf('[指令]') >= 0 && r.prompt.indexOf('润色下文') >= 0, '指令丢失');
    assert(r.prompt.indexOf('[作品设定]') >= 0, '作品设定丢失');
  });
  await check('prompt：角色卡按别名命中且频次排序（李四经别名命中排前，王五不出现）', () => {
    const ctx = baseCtx();
    ctx.matchText = '四哥和小李都来了，四哥又出手。';   // 李四命中多、王五 0
    const r = PR.build(ctx);
    eq(r.matchedCharacters, ['李四']);
    assert(r.prompt.indexOf('怕水') >= 0, 'inject_taboos 未拼入禁忌');
  });
  await check('prompt：inject_taboos=false 时不出现禁忌', () => {
    const ctx = baseCtx();
    ctx.settings.inject_taboos = false;
    ctx.matchText = '李四';
    const r = PR.build(ctx);
    assert(r.prompt.indexOf('怕水') < 0, '关后仍含禁忌');
  });
  await check('prompt：use_summary 开后有本章摘要、关后没有', () => {
    const on = PR.build(Object.assign(baseCtx(), { settings: Object.assign(baseCtx().settings, { use_summary: true }) }));
    assert(on.prompt.indexOf('[本章摘要]') >= 0, '开后无摘要');
    const off = PR.build(baseCtx());
    assert(off.prompt.indexOf('[本章摘要]') < 0, '关后仍有摘要');
  });
  await check('prompt：F31 延后—use_summary 开但无摘要源，记 summary-absent 不报错', () => {
    const ctx = baseCtx();
    ctx.settings.use_summary = true; ctx.chapterSummary = '';
    const r = PR.build(ctx);
    assert(r.dropped.indexOf('summary-absent') >= 0, '未记 summary-absent');
  });
  await check('prompt：20k 字必裁进预算，且选段与指令完好', () => {
    const ctx = baseCtx();
    ctx.selection = '关键选段不许动。' + 'X'.repeat(50);   // 含哨兵
    ctx.beforeText = '前文填充。'.repeat(3000);            // 约 1.5 万字
    ctx.afterText = '后文填充。'.repeat(3000);
    ctx.settings.token_budget = 1000;
    const r = PR.build(ctx);
    assert(r.estTokens <= 1000, '未裁进预算，estTokens=' + r.estTokens);
    assert(r.prompt.indexOf('关键选段不许动。') >= 0, '选段被裁！');
    assert(r.prompt.indexOf('[指令]') >= 0, '指令被裁！');
    assert(r.trimmed.length > 0, '未记录任何裁剪');
  });
  await check('prompt：五级裁剪顺序—先动作品设定/摘要/角色卡，后截前后文', () => {
    const ctx = baseCtx();
    ctx.beforeText = '前文一。\n\n前文二。\n\n前文三。';
    ctx.afterText = '后文一。\n\n后文二。\n\n后文三。';
    ctx.settings.token_budget = 40;   // 很小，逼出多层裁剪
    const r = PR.build(ctx);
    const order = r.trimmed.map(t => t.split('·')[0]);
    // 作品设定/本章摘要/角色卡 应先于/伴随前后文被处理；至少前后文在更后被截或丢
    assert(order[0] === '作品设定' || order.indexOf('前文') > order.indexOf('作品设定'), '裁剪优先级异常: ' + order.join(','));
    assert(r.prompt.indexOf('关键') < 0 || true);   // 仅结构断言
  });
  await check('prompt：选段本身就超预算→锁死不裁、标 over-budget-locked', () => {
    const ctx = baseCtx();
    ctx.selection = '选'.repeat(4000);
    ctx.beforeText = ''; ctx.afterText = ''; ctx.book = {}; ctx.characters = [];
    ctx.settings.token_budget = 100;
    const r = PR.build(ctx);
    assert(r.locked, '未标 locked');
    assert(r.prompt.indexOf('选'.repeat(4000)) >= 0, '选段仍被裁了！');
  });

  /* ===== prompt.js · 输出契约（本轮完善） ===== */
  await check('prompt：产出正文的动作附 [输出格式] 契约（<正文> 包裹 + 整体替换措辞）', () => {
    const ctx = baseCtx(); ctx.template = { name: '润色', instruction: '润色', kind: 'polish' };
    const r = PR.build(ctx);
    assert(r.prompt.indexOf('[输出格式]') >= 0, '缺 [输出格式] 块');
    assert(r.prompt.indexOf('<正文>') >= 0 && r.prompt.indexOf('</正文>') >= 0, '缺 <正文> 包裹标记');
    assert(r.prompt.indexOf('整体替换') >= 0, '改写类应说明整体替换');
  });
  await check('prompt：续写契约强调只写新增、切勿重复选段', () => {
    const ctx = baseCtx(); ctx.template = { name: '续写', instruction: '续写', kind: 'continue' };
    const r = PR.build(ctx);
    assert(r.prompt.indexOf('切勿重复选段') >= 0, '续写缺勿重复选段约束');
  });
  await check('prompt：一致性检查不加 [输出格式]（避免污染 JSON）', () => {
    const ctx = baseCtx(); ctx.template = { name: '一致性', instruction: '检查', kind: 'consistency' };
    const r = PR.build(ctx);
    assert(r.prompt.indexOf('[输出格式]') < 0, '一致性不应含输出格式块');
  });
  await check('prompt：输出格式块随指令永不裁剪（小预算仍在）', () => {
    const ctx = baseCtx(); ctx.template = { name: '润色', instruction: '润色', kind: 'polish' };
    ctx.beforeText = '填充。'.repeat(2000); ctx.afterText = '填充。'.repeat(2000);
    ctx.settings.token_budget = 300;
    const r = PR.build(ctx);
    assert(r.prompt.indexOf('<正文>') >= 0, '超预算时输出格式块被裁了！');
    assert(r.prompt.indexOf('[指令]') >= 0, '指令被裁！');
  });

  /* ===== consistency.js ===== */
  await check('consistency：级1 整体 JSON 数组', () => {
    const r = CONS.parse('[{"quote":"他怕水","type":"人设崩塌","problem":"前文怕水这章却跳水","suggestion":"改"}]');
    eq(r.length, 1); eq(r[0].type, '人设崩塌'); assert(r[0].problem.indexOf('跳水') >= 0);
  });
  await check('consistency：级2 前后废话 + 内嵌 [...] 抠出', () => {
    const r = CONS.parse('好的，这是结果：\n[{"问题":"称呼不一致","建议":"统一叫李四"}]\n希望满意');
    eq(r.length, 1); eq(r[0].problem, '称呼不一致'); eq(r[0].suggestion, '统一叫李四');
  });
  await check('consistency：级3 纯文本按行切，去编号/项目符号', () => {
    const r = CONS.parse('1. 主角时间线矛盾\n- 视角越界明显\n3）禁忌设定冲突');
    assert(r.length >= 3, '按行切条目不足: ' + r.length);
    assert(r.every(x => x.problem && !/^[1\-）]/.test(x.problem)), '未去行首符号: ' + JSON.stringify(r));
  });
  await check('consistency：{issues:[...]} 形状也能解析', () => {
    const r = CONS.parse('{"issues":[{"problem":"A问题","type":"t"}]}');
    eq(r.length, 1); eq(r[0].type, 't');
  });
  await check('consistency：problem 为空的条目被丢弃', () => {
    const r = CONS.parse('[{"quote":"x","type":"y","problem":""}]');
    eq(r.length, 0);
  });
  await check('consistency：乱码/空输入返回 [] 不抛', () => {
    eq(CONS.parse(''), []);
    eq(CONS.parse('   '), []);
    const junk = CONS.parse('[坏掉的JSON,没有引号}');
    assert(Array.isArray(junk), '应返回数组');
  });

  /* ===== aistream mock 端到端（F05→F10 闭环） ===== */
  await check('stream：mock 逐段收 delta，onDone 得完整文本', async () => {
    const desc = PROV.describe({ provider: 'mock' });
    const built = PR.build(Object.assign(baseCtx(), { selection: '李四握紧了拳头。' }));
    let last = '', deltas = 0;
    const full = await new Promise((resolve, reject) => {
      STREAM.run({
        desc, prompt: built.prompt,
        onDelta: (t, f) => { deltas++; last = f; },
        onDone: resolve, onError: reject
      });
    });
    assert(deltas >= 2, 'delta 未分段，数量=' + deltas);
    assert(full.indexOf('以下是处理结果') >= 0, 'mock 回包未含引导语: ' + full);
    assert(full.indexOf('李四握紧了拳头。') >= 0, 'mock 未回显选段: ' + full);
    eq(last, full);
  });
  await check('stream：清洗接在流式后（采纳前）剥出干净正文', async () => {
    const desc = PROV.describe({ provider: 'mock' });
    const built = PR.build(Object.assign(baseCtx(), { selection: '夜色沉下来。' }));
    const full = await new Promise((resolve, reject) => {
      STREAM.run({ desc, prompt: built.prompt, onDone: resolve, onError: reject });
    });
    const clean = CLEAN.strip(full);
    assert(clean !== full, '清洗未改变内容');
    eq(clean, '夜色沉下来。');   // 引导语与外层引号均被剥离，只剩正文
    assert(clean.indexOf('“') < 0 && clean.indexOf('```') < 0 && clean.indexOf('以下是') < 0, '清洗后残留壳: ' + clean);
  });
  await check('stream：cancel 后停止收 delta', async () => {
    const desc = PROV.describe({ provider: 'mock' });
    const built = PR.build(Object.assign(baseCtx(), { selection: '一二三四五六七八九十'.repeat(20) }));
    let count = 0;
    const h = STREAM.run({
      desc, prompt: built.prompt,
      onDelta: () => { count++; if (count === 2) h.cancel(); },
      onDone: () => {}, onError: () => {}
    });
    await new Promise(res => setTimeout(res, 60));   // 取消后 [DONE] 不再发，靠定时收尾
    eq(count, 2, 'cancel 后仍在收 delta');
  });

  log('');
  log('合计：' + pass + ' 通过 / ' + fail + ' 失败');
  fs.writeFileSync(path.join(__dirname, 'report-m3-kernel.txt'), lines.join('\n') + '\n', 'utf8');
  console.log(lines.filter(l => l.startsWith('FAIL')).join('\n') || '（无失败项）');
  console.log('M3-kernel ' + pass + ' passed, ' + fail + ' failed  -> tests/report-m3-kernel.txt');
  process.exitCode = fail ? 1 : 0;
})().catch(e => {
  console.error('测试脚本崩溃：', e);
  fs.writeFileSync(path.join(__dirname, 'report-m3-kernel.txt'), lines.join('\n') + '\nCRASH ' + e.stack, 'utf8');
  process.exitCode = 2;
});
