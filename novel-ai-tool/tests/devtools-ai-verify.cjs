/* devtools-ai-verify.cjs —— 真机验证本轮 AI 工具改动（CDP，需先 adb forward tcp:9222）
   只调用 www/ 里的纯逻辑模块（NOVEL_CLEAN / NOVEL_ADOPT / NOVEL_PROMPT / NOVEL_UTIL），
   无 DOM、不写库、不联网（不经 apiReady 门禁），因此在真机 WebView 里可稳定复算：
   ① 模块确被新 APK 加载（函数指纹：applyResult 有 6 形参、clean 导出 extractDelimited）；
   ② clean 固定格式 <正文> 取最长、无标记回退启发式；
   ③ adopt replace 与 insert 都剥回显重复原文、缺 opts 向后兼容；
   ④ prompt 对产出正文动作附 [输出格式] 契约、续写强调勿复述、一致性不加；
   ⑤ 定位=系统选区 的底层等效（孤立标记下 stripMarkers/mapToClean 仍正确）；
   ⑥ prompt→(mock 合规回包)→clean 链路串通。
   运行：node tests/devtools-ai-verify.cjs */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const EXPR = `(async () => {
  const g = globalThis, out = { errs: [], checks: {} };
  window.addEventListener('error', e => out.errs.push('onerror: ' + (e.message || e)));
  const NL = String.fromCharCode(10);
  const U = g.NOVEL_UTIL, C = g.NOVEL_CLEAN, AD = g.NOVEL_ADOPT, PR = g.NOVEL_PROMPT, A = g.NOVEL_APP;
  const O = U.MARK_OPEN, CL = U.MARK_CLOSE;   // ⟦ ⟧
  const chk = (k, v) => { out.checks[k] = !!v; };

  chk('boot', !!(A && A.state));
  // === 函数指纹：证明装的是本轮新包 ===
  chk('fingerprint_applyResult_6args', AD.applyResult.length === 6);
  chk('fingerprint_clean_extractExport', !!(C._internal && typeof C._internal.extractDelimited === 'function'));

  // === ② clean：固定格式取最长 + 回退 ===
  chk('clean_longest_skipEmptyEcho', C.strip('好的<正文></正文>' + NL + '<正文>夜色沉下来。</正文>还要改吗') === '夜色沉下来。');
  chk('clean_singlePairStripPreamble', C.strip('以下是续写：' + NL + '<正文>推门而入。</正文>' + NL + '要改吗') === '推门而入。');
  chk('clean_fallbackNoMarker', C.strip('以下是结果：' + NL + '\\u201c正文。\\u201d') === '正文。');   // 无标签回退旧启发式（剥引导语+外层引号）
  chk('clean_extractNullWhenNoTag', C._internal.extractDelimited('无任何标记') === null);
  chk('clean_extractMultiTakesLongest', C._internal.extractDelimited('说明<正文></正文>废话<正文>真正文在这里</正文>尾') === '真正文在这里');

  // === ③ adopt：replace/insert 去重复原文 + 向后兼容 ===
  const B = '他走进房间。桌上有杯水。';
  chk('adopt_replace_dedup', AD.applyResult('replace', B, 0, 6, '他走进房间。屋里光线昏暗。', { selection: '他走进房间。' }).newBody === '屋里光线昏暗。桌上有杯水。');
  chk('adopt_insert_dedup', AD.applyResult('insert', B, 6, 6, '他走进房间。屋里很安静。', { selection: '他走进房间。' }).newBody === '他走进房间。' + NL + '屋里很安静。' + NL + '桌上有杯水。');
  chk('adopt_insert_pureEcho_noChange', AD.applyResult('insert', B, 6, 6, '他走进房间。', { selection: '他走进房间。' }).changed === false);
  chk('adopt_replace_notEchoNoTouch', AD.applyResult('replace', B, 0, 6, '夜色降临。', { selection: '他走进房间。' }).newBody === '夜色降临。桌上有杯水。');
  chk('adopt_noOpts_backwardCompat', AD.applyResult('replace', B, 0, 6, '他走进房间。改。').newBody === '他走进房间。改。桌上有杯水。');

  // === ④ prompt：输出契约 ===
  const mkCtx = kind => ({ selection: '原句', template: { name: kind, instruction: '做点处理', kind: kind }, settings: { token_budget: 6000 } });
  const pp = PR.build(mkCtx('polish')), pc = PR.build(mkCtx('continue')), pco = PR.build(mkCtx('consistency'));
  chk('prompt_polish_hasFormatBlock', pp.prompt.indexOf('[输出格式]') >= 0);
  chk('prompt_polish_hasBodyTag', pp.prompt.indexOf('<正文>') >= 0 && pp.prompt.indexOf('</正文>') >= 0);
  chk('prompt_polish_hasReplaceWord', pp.prompt.indexOf('整体替换') >= 0);
  chk('prompt_continue_hasNoEcho', pc.prompt.indexOf('切勿重复选段') >= 0);
  chk('prompt_consistency_noFormatBlock', pco.prompt.indexOf('[输出格式]') < 0);

  // === ⑤ 定位=系统选区 的底层等效（孤立标记） ===
  chk('util_mapToClean_isolatedMarker', JSON.stringify(U.mapToClean('a' + O + 'bc', 3, 4)) === JSON.stringify({ start: 2, end: 3 }));
  chk('util_stripMarkers_isolated', U.stripMarkers('a' + O + 'bc') === 'abc');
  // 定位标记路径：extractMarked 给去标记 base + base 内偏移，与系统选区去标记后同基
  const em = U.extractMarked('前' + O + '中' + CL + '后');
  chk('util_extractMarked_sameBase', em && em.base === '前中后' && em.text === '中' && em.start === 1 && em.end === 2);

  // === ⑥ 链路：prompt.build 产出正文 → mock 合规回包 → clean 抽出净正文 ===
  const built = PR.build(mkCtx('polish'));
  const fakeModel = '好的，处理如下：' + NL + '<正文>润色后的句子更凝练。</正文>' + NL + '还需要调整吗？';
  chk('chain_promptCarriesContract', built.prompt.indexOf('[输出格式]') >= 0);
  chk('chain_cleanYieldsPureBody', C.strip(fakeModel) === '润色后的句子更凝练。');

  return JSON.stringify(out);
})()`;

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
  if (!val) { console.log('EVAL_FAIL', JSON.stringify(r && r.exceptionDetails)); ws.close(); return; }
  const parsed = JSON.parse(val);
  const checks = parsed.checks;
  const keys = Object.keys(checks);
  const bad = keys.filter(k => !checks[k]);
  console.log('errs: ' + JSON.stringify(parsed.errs));
  console.log(JSON.stringify(checks, null, 2));
  console.log('AI-VERIFY ' + (keys.length - bad.length) + '/' + keys.length + ' passed' + (bad.length ? '  FAILED: ' + bad.join(', ') : ''));
  ws.close();
  process.exitCode = bad.length || parsed.errs.length ? 1 : 0;
})().catch(e => { console.error('PROBE_ERR', e.message); process.exitCode = 2; });
