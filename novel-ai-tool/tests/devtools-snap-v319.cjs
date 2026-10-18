/* devtools-snap-v319.cjs —— 抓 v3.19 新界面存证：
   1) 节编辑器 FAB 展开：定位/选中全文 + 4 个动作 + AI查找 + 更多
   2) 定位标记态：正文里出现 ⟦…⟧
   3) AI查找 提问弹层
   4) “我的 › AI 助手”：掩码密钥框 + 下拉无 mock
   运行：node tests/devtools-snap-v319.cjs（先 adb forward tcp:9222 ...） */
const fs = require('fs');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const SETUP = `(async () => {
  const db = globalThis.NOVEL_DB;
  let bs = await db.listBooks(); if (!bs.length) await db.createBook({ title: 'v319截图书' });
  bs = await db.listBooks(); const bookId = bs[0].id;
  const chId = await db.createChapter(bookId, '第三章 夜袭');
  const secId = await db.createSection(chId, '第1节 潜入');
  await db.saveSectionBody(secId, '夜色沉下来，灯一盏盏亮了。他翻墙而入，脚步很轻。');
  return JSON.stringify({ bookId, chId, secId });
})()`;

(async () => {
  const t = await (await fetch(BASE + '/json')).json();
  const p = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!p) { console.log('NO_PAGE'); return; }
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let id = 0; const pm = new Map();
  const send = (m, prm) => new Promise((r, j) => { const i = ++id; pm.set(i, { res: r, rej: j }); ws.send(JSON.stringify({ id: i, method: m, params: prm || {} })); });
  ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pm.has(msg.id)) { const pp = pm.get(msg.id); pm.delete(msg.id); msg.error ? pp.rej(new Error(JSON.stringify(msg.error))) : pp.res(msg.result); } };
  await new Promise(r => ws.addEventListener('open', r));

  const setupRes = await send('Runtime.evaluate', { expression: SETUP, awaitPromise: true, returnByValue: true });
  const { bookId, chId, secId } = JSON.parse(setupRes.result.value);
  console.log('setup', bookId, chId, secId);

  async function nav(hash) { await send('Runtime.evaluate', { expression: 'NOVEL_APP.go("' + hash + '")' }); await new Promise(r => setTimeout(r, 700)); }
  async function evalx(js, ap) { return send('Runtime.evaluate', { expression: js, awaitPromise: !!ap, returnByValue: true }); }
  async function snap(file) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    console.log('saved', file);
  }

  // 1) FAB 展开
  await nav('#/section/' + chId + '/' + secId);
  await evalx('document.querySelector("#fabBtn").click()');
  await new Promise(r => setTimeout(r, 350));
  await snap('tests/v319-fab-open.png');

  // 2) 定位标记态：选区 [9,14) 后点定位
  await evalx('(()=>{const ta=document.querySelector("#body.ta");ta.value="夜色沉下来，灯一盏盏亮了。";ta.setSelectionRange(6,13);document.querySelector(\'.fab-item[data-act="locate"]\').click();})()');
  await new Promise(r => setTimeout(r, 250));
  await snap('tests/v319-locate.png');

  // 3) AI查找 提问弹层（直接 .click() 事件不受 pointer-events 限制，无需先展开 FAB）
  await evalx('document.querySelector(\'.fab-item[data-act="query"]\').click()');
  await new Promise(r => setTimeout(r, 350));
  await snap('tests/v319-query.png');

  // 4) 我的 › AI 助手：掩码密钥框 + 下拉
  await nav('#/me');
  await new Promise(r => setTimeout(r, 300));
  await snap('tests/v319-me-ai.png');

  // 清理
  await evalx('(async()=>{const db=NOVEL_DB;await db.deleteChapter(' + chId + ');return "cleared";})()', true);
  console.log('cleaned');
  ws.close();
})().catch(e => console.error('SNAP_ERR', e.message));
