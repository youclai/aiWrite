/* devtools-m9b-probe.cjs —— 补充验证：章级编辑器（版本钮+FAB）、人物卡 .it-actions 按钮下移
   运行：node tests/devtools-m9b-probe.cjs */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const EXPR = `(async () => {
  const g = globalThis, A = g.NOVEL_APP, db = g.NOVEL_DB, out = { steps: [], errs: [] };
  window.addEventListener('error', e => out.errs.push('onerror: ' + (e.message || e)));
  const wait = ms => new Promise(r => setTimeout(r, ms));

  const bs = await db.listBooks();
  if (!bs.length) await db.createBook({ title: 'v318验证书' });
  const bookId = (await db.listBooks())[0].id;

  // 建人物并查卡片按钮下移
  await db.saveCharacter(bookId, { name: '张三', role: '主角', personality: '冷静克制', speech_style: '短句' });
  A.go('#/book/' + bookId + '/chars'); await wait(500);
  const item = document.querySelector('.item');
  out.steps.push({ t: 'char-card', hasItem: !!item,
    hasActions: !!(item && item.querySelector('.it-actions')),
    editInActions: !!(item && item.querySelector('.it-actions [data-edit]')),
    headHasBtn: !!(item && item.querySelector('.it-h button')) });

  // 章级编辑器：版本按钮存在 + FAB 存在
  const chId = await db.createChapter(bookId, '章级测试');
  A.go('#/editor/' + bookId + '/' + chId); await wait(600);
  out.steps.push({ t: 'chapter-editor', hash: location.hash,
    hasVerBtn: !!document.querySelector('#verBtn'),
    fabMain: !!document.querySelector('#fabBtn'),
    taFlex: getComputedStyle(document.querySelector('#body.ta')).flex,
    backTarget: document.querySelector('.back[data-back]') && document.querySelector('.back[data-back]').getAttribute('data-back') });

  await db.deleteChapter(chId);
  const cs = await db.listCharacters(bookId);
  const zhangsan = cs.find(c => c.name === '张三');
  if (zhangsan) await db.deleteCharacter(zhangsan.id);

  return JSON.stringify(out);
})()`;
(async () => {
  const t = await (await fetch(BASE + '/json')).json();
  const p = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let id = 0; const pm = new Map();
  const send = (m, q) => new Promise((res, rej) => { const i = ++id; pm.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: q || {} })); });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pm.has(m.id)) { const x = pm.get(m.id); pm.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  const v = r && r.result && r.result.value;
  if (!v) { console.log('EVAL_FAIL', JSON.stringify(r)); ws.close(); return; }
  const o = JSON.parse(v); console.log('errs:', JSON.stringify(o.errs));
  o.steps.forEach(s => console.log(JSON.stringify(s)));
  ws.close();
})().catch(e => console.error('PROBE_ERR', e.message));
