/* devtools-m10-probe.cjs —— 真机验证 v3.19：
   1) apiReady 配置门禁：mock / 无 Key 一律拦截；真实 provider+Key 才放行
   2) 未配置时点 AI 动作：预览不出现（不产结果，杜绝"结果串台"）
   3) 定位：data-act=locate 在选区前后插入标记；stripMarkers/extractMarked 还原干净正文
   4) 选中全文：整篇被标记包裹
   5) 字数统计基于去标记正文（标记不污染字数、不入库）
   6) FAB 组成：定位/选中全文/AI查找 工具项存在；快捷项已移除"转对话"
   7) API Key 掩码框：type=text + class masked + -webkit-text-security:disc（可粘贴不可查看）
   8) Provider 下拉无 mock，含未配置占位
   运行：node tests/devtools-m10-probe.cjs （需先 adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>） */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const EXPR = `(async () => {
  const g = globalThis, A = g.NOVEL_APP, U = g.NOVEL_UTIL, db = g.NOVEL_DB;
  const out = { checks: [], errs: [] };
  window.addEventListener('error', e => out.errs.push('onerror: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', e => out.errs.push('reject: ' + (e.reason && (e.reason.message || e.reason))));
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // === A: apiReady 门禁（纯逻辑）===
  const native = !!A.nativeAiStream();
  out.checks.push({ t: 'apiReady', native,
    mock: A.apiReady({ provider: 'mock' }),
    empty: A.apiReady({}),
    noKey: A.apiReady({ provider: 'deepseek', key_set: false }),
    realKey: A.apiReady({ provider: 'deepseek', key_set: true }) });

  // === 备数据：书→章→节 ===
  const bs = await db.listBooks();
  if (!bs.length) await db.createBook({ title: 'v319验证书' });
  const books = await db.listBooks(); const bookId = books[0].id;
  const chapId = await db.createChapter(bookId, 'v319测试章');
  const secId = await db.createSection(chapId, '第1节');
  A.go('#/section/' + chapId + '/' + secId); await wait(600);
  const ta = document.querySelector('#body.ta');
  const clean = '甲乙丙丁戊';

  // === B: 定位插入标记 ===
  ta.value = clean; ta.dispatchEvent(new Event('input')); await wait(20);
  ta.setSelectionRange(1, 3); // 选中 乙丙
  document.querySelector('.fab-item[data-act="locate"]').click(); await wait(80);
  const located = ta.value; const mk = U.extractMarked(located);
  out.checks.push({ t: 'locate', hasOpen: located.indexOf(U.MARK_OPEN) >= 0, hasClose: located.indexOf(U.MARK_CLOSE) >= 0,
    strippedEquals: U.stripMarkers(located) === clean, text: mk ? mk.text : null, base: mk ? mk.base : null,
    offsets: mk ? [mk.start, mk.end] : null });

  // === C: 字数基于去标记正文（含标记时仍显示 5 字）===
  ta.value = U.markSelection(clean, 1, 3); ta.dispatchEvent(new Event('input')); await wait(30);
  const wcTxt = document.querySelector('#wc').textContent;
  out.checks.push({ t: 'wc-stripped', wcTxt, expect: db.countWords(clean) + ' 字', ok: wcTxt === (db.countWords(clean) + ' 字') });

  // === D: 选中全文包裹整篇 ===
  ta.value = clean; ta.dispatchEvent(new Event('input')); await wait(20);
  document.querySelector('.fab-item[data-act="all"]').click(); await wait(80);
  const allMk = U.extractMarked(ta.value);
  out.checks.push({ t: 'select-all', wrapHead: ta.value.charAt(0) === U.MARK_OPEN,
    wrapTail: ta.value.charAt(ta.value.length - 1) === U.MARK_CLOSE, text: allMk ? allMk.text : null });

  // === E: 未配置时点 AI 动作 → 预览不出现（结果不串台/不产 mock）===
  ta.value = clean; ta.dispatchEvent(new Event('input')); await wait(20);
  if (typeof A._runAction === 'function') { A._runAction({ kind: 'polish', name: '润色', instruction: 'x' }); await wait(120); }
  const curApi = await db.getSetting('api');
  out.checks.push({ t: 'blocked-noconfig', provider: curApi && curApi.provider, pvHidden: document.querySelector('#pv').hidden });

  // === F: FAB 组成 ===
  const kinds = [].map.call(document.querySelectorAll('.fab-item[data-kind]'), b => b.getAttribute('data-kind'));
  out.checks.push({ t: 'fab', toolCount: document.querySelectorAll('.fab-item[data-act]').length,
    kindCount: kinds.length, hasQuery: !!document.querySelector('.fab-item[data-act="query"]'),
    noDialogueQuick: kinds.indexOf('dialogue') < 0 });

  // === G/H: “我的”密钥掩码框 + Provider 下拉 ===
  A.go('#/me'); await wait(700);
  const keyEl = document.querySelector('#key'); const cs = keyEl ? getComputedStyle(keyEl) : null;
  const provOpts = [].map.call(document.querySelectorAll('#prov option'), o => o.value);
  out.checks.push({ t: 'key-mask', type: keyEl ? keyEl.type : null, masked: keyEl ? keyEl.classList.contains('masked') : false,
    textSecurity: cs ? (cs.webkitTextSecurity || cs.getPropertyValue('-webkit-text-security')) : null });
  out.checks.push({ t: 'prov-options', hasMock: provOpts.indexOf('mock') >= 0, hasPlaceholder: provOpts.indexOf('') >= 0 });

  await db.deleteChapter(chapId); // 级联删节
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
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  const val = r && r.result && r.result.value;
  if (!val) { console.log('EVAL_FAIL', JSON.stringify(r)); ws.close(); return; }
  const parsed = JSON.parse(val);
  console.log('errs:', JSON.stringify(parsed.errs));
  parsed.checks.forEach(c => console.log(JSON.stringify(c)));
  ws.close();
})().catch(e => console.error('PROBE_ERR', e.message));
