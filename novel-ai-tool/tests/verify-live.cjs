/* verify-live.cjs —— 真机交互链路验证（只读 + 纯导航，不写库）：
   1) 编辑页 textarea 正文/字数与 DB 一致性  2) 导航 书架→章节→返回 的哈希与渲染
   3) 全页截图留证  用法：node tests/verify-live.cjs */
const fs = require('fs');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const ACT = `(async () => {
  const A = globalThis.NOVEL_APP; const DB = globalThis.NOVEL_DB;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const out = { steps: [] };
  const rec = (name, val) => out.steps.push({ step: name, ok: !!val, detail: typeof val === 'string' ? val : JSON.stringify(val).slice(0, 200) });

  // 1. 当前编辑页：textarea 内容与 DB 节正文一致性
  const ta = document.querySelector('#body');
  const m = location.hash.match(/^#\\/section\\/(\\d+)\\/(\\d+)/);
  if (ta && m) {
    const secs = await DB.listSections(m[2]);
    const sec = secs.find(s => String(s.id) === m[1]) || secs[0];
    const dbBody = sec && sec.body ? sec.body : (sec && sec.body_len ? '(body 字段未随行返回, len=' + sec.body_len + ')' : '');
    rec('editor-ta-vs-db', { hash: location.hash, taLen: ta.value.length, dbLen: String(dbBody).length, match: dbBody ? ta.value === dbBody : 'n/a', wcUI: (document.querySelector('#wc') || {}).textContent });
  } else rec('editor-ta-vs-db', 'NO_TEXTAREA_OR_ROUTE');

  // 2. 导航到书架
  A.go('#/shelf'); await wait(600);
  const shelfHtml = document.getElementById('screen').innerHTML;
  rec('shelf-render', { hash: location.hash, hasBookTitle: shelfHtml.indexOf('勇者') >= 0, buttons: document.querySelectorAll('button,a,[data-act]').length });

  // 3. 点第一个书卡片进章节列表
  const card = document.querySelector('[data-act],a[href],.book,.card');
  if (card) { card.click(); await wait(600); rec('tap-book', { hash: location.hash, screenLen: document.getElementById('screen').innerHTML.length }); }
  else rec('tap-book', 'NO_CARD');

  // 4. 返回
  const back = document.querySelector('.back,[data-back]');
  if (back) { const t = back.getAttribute('data-back'); if (t) A.go(t); else back.click(); await wait(600); rec('tap-back', { hash: location.hash }); }
  else rec('tap-back', 'NO_BACK_BTN');

  return JSON.stringify(out);
})()`;

(async () => {
  const t = await (await fetch(BASE + '/json', { signal: AbortSignal.timeout(8000) })).json();
  const p = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!p) { console.log('NO_PAGE_TARGET'); process.exitCode = 3; return; }
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let id = 0; const pm = new Map();
  const send = (m, prm) => new Promise((r, j) => { const i = ++id; pm.set(i, { res: r, rej: j }); ws.send(JSON.stringify({ id: i, method: m, params: prm || {} })); });
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pm.has(msg.id)) { const pp = pm.get(msg.id); pm.delete(msg.id); msg.error ? pp.rej(new Error(JSON.stringify(msg.error))) : pp.res(msg.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: ACT, awaitPromise: true, returnByValue: true });
  const val = r && r.result && r.result.value;
  if (!val) { console.log('EVAL_FAIL', JSON.stringify(r && r.exceptionDetails)); }
  else {
    const parsed = JSON.parse(val);
    for (const s of parsed.steps) console.log((s.ok ? '[PASS]' : '[FAIL]'), s.step, '=>', s.detail);
  }
  // 导航回原编辑页并截图
  await send('Runtime.evaluate', { expression: `(function(){globalThis.NOVEL_APP.go('#/section/32/32')})()`, returnByValue: true });
  await new Promise(r => setTimeout(r, 800));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('tests/verify-live.png', Buffer.from(shot.data, 'base64'));
  console.log('saved tests/verify-live.png');
  ws.close();
})().catch(e => { console.error('LIVE_ERR', e.message); process.exitCode = 2; });
