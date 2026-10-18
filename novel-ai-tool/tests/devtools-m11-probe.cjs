/* devtools-m11-probe.cjs —— 真机验证"配置 AI 助手"增强：
   1) Provider 下拉：友好名称、无 mock/无空占位、默认"自定义"
   2) Model 为下拉（非自由输入）：选 DeepSeek → 自动带入 base + 选中 deepseek-flash，清单含 deepseek-v4-pro
   3) 选 通义千问 → 带入 dashscope 地址并选中 qwen-plus
   4) 选 自定义 → 无预设清单 → Model 落到"手动输入…"且文本框可见、值为空
   5) 清单外模型：切"手动输入…"可手填自定义 ID
   6) 保存拦截：Base URL 为空时 toast 提示、不落库
   运行：node tests/devtools-m11-probe.cjs（先 adb forward tcp:9222 ...） */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const EXPR = `(async () => {
  const g = globalThis, A = g.NOVEL_APP, db = g.NOVEL_DB;
  const out = { checks: [], errs: [] };
  window.addEventListener('error', e => out.errs.push('onerror: ' + (e.message || e)));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const pick = k => { const s = document.querySelector('#prov'); s.value = k; s.dispatchEvent(new Event('change')); };
  const pickModel = v => { const s = document.querySelector('#model'); s.value = v; s.dispatchEvent(new Event('change')); };
  // 有效模型值：下拉选中项；若为“手动输入…”则取文本框
  const effModel = () => { const s = document.querySelector('#model'); return s.value === '__custom__' ? document.querySelector('#modelCustom').value : s.value; };

  // 备份当前 api 配置，测完还原（不污染用户真实配置）
  const before = await db.getSetting('api');

  A.go('#/me'); await wait(700);
  const prov = document.querySelector('#prov');
  const optVals = [].map.call(prov.querySelectorAll('option'), o => o.value);
  const optTexts = [].map.call(prov.querySelectorAll('option'), o => o.textContent);
  out.checks.push({ t: 'dropdown', noMock: optVals.indexOf('mock') < 0, noEmpty: optVals.indexOf('') < 0,
    defaultCustom: prov.value === 'custom', hasFriendlyLabel: optTexts.some(x => /DeepSeek|通义|Claude/.test(x)) });

  const ms0 = document.querySelector('#model');
  const msOpts = [].map.call(ms0.querySelectorAll('option'), o => o.value);
  out.checks.push({ t: 'model-is-select', isSelect: ms0.tagName === 'SELECT', hasCustomOption: msOpts.indexOf('__custom__') >= 0 });

  pick('deepseek'); await wait(60);
  const dsOpts = [].map.call(document.querySelector('#model').querySelectorAll('option'), o => o.value);
  out.checks.push({ t: 'deepseek', base: document.querySelector('#base').value, model: effModel(),
    hasPro: dsOpts.indexOf('deepseek-v4-pro') >= 0, hint: document.querySelector('#provHint').textContent });

  pick('qwen'); await wait(60);
  out.checks.push({ t: 'qwen', base: document.querySelector('#base').value, model: effModel() });

  // 清单外模型：切“手动输入…”可手填
  pickModel('__custom__'); document.querySelector('#modelCustom').value = 'my-own-model'; await wait(30);
  out.checks.push({ t: 'manual-input', customVisible: !document.querySelector('#modelCustom').hidden, model: effModel() });

  pick('custom'); await wait(60);
  out.checks.push({ t: 'custom-cleared', base: document.querySelector('#base').value, model: effModel(),
    customVisible: !document.querySelector('#modelCustom').hidden, hint: document.querySelector('#provHint').textContent });

  // 保存拦截：custom 且 Base 为空 → 不落库
  document.querySelector('#modelCustom').value = '';
  document.querySelector('#key').value = '';
  document.querySelector('#saveApi').click(); await wait(120);
  const afterSave = await db.getSetting('api');
  out.checks.push({ t: 'save-guard', stillMockOrUnchanged: (afterSave.provider === before.provider && afterSave.base_url === before.base_url) });

  // 还原（pick 只改 DOM，未落库；保险再写回原值）
  await db.setSetting('api', before);
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
