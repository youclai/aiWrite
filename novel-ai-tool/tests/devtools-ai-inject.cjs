/* devtools-ai-inject.cjs —— 绕开 MagicOS 装机拦截，直接在本机 WebView 引擎里验证本轮 AI 改动。
   做法：用 CDP 连到设备上正在运行的 App 的 WebView，从磁盘读入 www/js 里四个新版纯逻辑模块
   （util/clean/adopt/prompt）的源码，注入覆盖同名全局，再复算断言。
   证明“新逻辑在真机 Chromium/V8 引擎里行为正确”，无需重装 APK。
   前置：App 已打开、adb forward tcp:9222 到 webview_devtools_remote 已建立。
   运行：node tests/devtools-ai-inject.cjs */
const fs = require('fs');
const path = require('path');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

// 读入新版模块源码（这些 IIFE 都以 globalThis 为 root，重复执行即覆盖旧全局）
const SRC = ['util.js', 'clean.js', 'adopt.js', 'prompt.js']
  .map(f => fs.readFileSync(path.join(__dirname, '..', 'www', 'js', f), 'utf8'))
  .join('\n;\n');

const CHECK = `(async () => {
  const g = globalThis, out = { errs: [], checks: {} };
  const NL = String.fromCharCode(10);
  const U = g.NOVEL_UTIL, C = g.NOVEL_CLEAN, AD = g.NOVEL_ADOPT, PR = g.NOVEL_PROMPT;
  const O = U.MARK_OPEN, CL = U.MARK_CLOSE;   // ⟦ ⟧
  const chk = (k, v) => { out.checks[k] = !!v; };

  // 注入是否生效：新版指纹
  chk('injected_clean_extractExport', !!(C._internal && typeof C._internal.extractDelimited === 'function'));
  chk('injected_adopt_6args', AD.applyResult.length === 6);

  // clean：固定格式取最长 + 无标记回退
  chk('clean_longest_skipEmptyEcho', C.strip('好的<正文></正文>' + NL + '<正文>夜色沉下来。</正文>还要改吗') === '夜色沉下来。');
  chk('clean_singlePairStripPreamble', C.strip('以下是续写：' + NL + '<正文>推门而入。</正文>' + NL + '要改吗') === '推门而入。');
  chk('clean_fallbackNoMarker', C.strip('以下是结果：' + NL + '\\u201c正文。\\u201d') === '正文。');
  chk('clean_extractNullWhenNoTag', C._internal.extractDelimited('无任何标记') === null);
  chk('clean_extractMultiTakesLongest', C._internal.extractDelimited('说明<正文></正文>废话<正文>真正文在这里</正文>尾') === '真正文在这里');

  // adopt：replace/insert 去重复原文 + 向后兼容
  const B = '他走进房间。桌上有杯水。';
  chk('adopt_replace_dedup', AD.applyResult('replace', B, 0, 6, '他走进房间。屋里光线昏暗。', { selection: '他走进房间。' }).newBody === '屋里光线昏暗。桌上有杯水。');
  chk('adopt_insert_dedup', AD.applyResult('insert', B, 6, 6, '他走进房间。屋里很安静。', { selection: '他走进房间。' }).newBody === '他走进房间。' + NL + '屋里很安静。' + NL + '桌上有杯水。');
  chk('adopt_insert_pureEcho_noChange', AD.applyResult('insert', B, 6, 6, '他走进房间。', { selection: '他走进房间。' }).changed === false);
  chk('adopt_replace_notEchoNoTouch', AD.applyResult('replace', B, 0, 6, '夜色降临。', { selection: '他走进房间。' }).newBody === '夜色降临。桌上有杯水。');
  chk('adopt_noOpts_backwardCompat', AD.applyResult('replace', B, 0, 6, '他走进房间。改。').newBody === '他走进房间。改。桌上有杯水。');

  // prompt：输出契约
  const mkCtx = kind => ({ selection: '原句', template: { name: kind, instruction: '做点处理', kind: kind }, settings: { token_budget: 6000 } });
  const pp = PR.build(mkCtx('polish')), pc = PR.build(mkCtx('continue')), pco = PR.build(mkCtx('consistency'));
  chk('prompt_polish_hasFormatBlock', pp.prompt.indexOf('[输出格式]') >= 0);
  chk('prompt_polish_hasBodyTag', pp.prompt.indexOf('<正文>') >= 0 && pp.prompt.indexOf('</正文>') >= 0);
  chk('prompt_polish_hasReplaceWord', pp.prompt.indexOf('整体替换') >= 0);
  chk('prompt_continue_hasNoEcho', pc.prompt.indexOf('切勿重复选段') >= 0);
  chk('prompt_consistency_noFormatBlock', pco.prompt.indexOf('[输出格式]') < 0);

  // util：定位=系统选区 的底层等效（孤立标记）
  chk('util_mapToClean_isolatedMarker', JSON.stringify(U.mapToClean('a' + O + 'bc', 3, 4)) === JSON.stringify({ start: 2, end: 3 }));
  chk('util_stripMarkers_isolated', U.stripMarkers('a' + O + 'bc') === 'abc');
  const em = U.extractMarked('前' + O + '中' + CL + '后');
  chk('util_extractMarked_sameBase', em && em.base === '前中后' && em.text === '中' && em.start === 1 && em.end === 2);

  // 链路：prompt 产出正文 → mock 合规回包 → clean 抽净正文
  const fakeModel = '好的，处理如下：' + NL + '<正文>润色后的句子更凝练。</正文>' + NL + '还需要调整吗？';
  chk('chain_cleanYieldsPureBody', C.strip(fakeModel) === '润色后的句子更凝练。');

  return JSON.stringify(out);
})()`;

const EXPR = SRC + '\n;\n' + CHECK;

(async () => {
  const targets = await (await fetch(BASE + '/json')).json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET'); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pend.has(msg.id)) { const p = pend.get(msg.id); pend.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  const val = r && r.result && r.result.value;
  if (!val) { console.log('EVAL_FAIL', JSON.stringify(r && r.exceptionDetails)); ws.close(); process.exitCode = 3; return; }
  const parsed = JSON.parse(val);
  const checks = parsed.checks, keys = Object.keys(checks);
  const bad = keys.filter(k => !checks[k]);
  console.log('page: ' + page.url);
  console.log(JSON.stringify(checks, null, 2));
  console.log('AI-INJECT-VERIFY ' + (keys.length - bad.length) + '/' + keys.length + ' passed' + (bad.length ? '  FAILED: ' + bad.join(', ') : ''));
  ws.close();
  process.exitCode = bad.length ? 1 : 0;
})().catch(e => { console.error('PROBE_ERR', e.message); process.exitCode = 2; });
