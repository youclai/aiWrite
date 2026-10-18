/* devtools-snap-v318.cjs —— 抓 v3.18 新界面：章详情(节列表) + 节编辑器(FAB展开) + 人物卡(按钮下移)
   运行：node tests/devtools-snap-v318.cjs */
const fs = require('fs');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const SETUP = `(async () => {
  const db = globalThis.NOVEL_DB, A = globalThis.NOVEL_APP;
  let bs = await db.listBooks(); if (!bs.length) await db.createBook({ title: 'v318截图书' });
  bs = await db.listBooks(); const bookId = bs[0].id;
  await db.saveCharacter(bookId, { name: '林墨', role: '主角', personality: '外冷内热，寡言', speech_style: '短句、点到为止' });
  await db.saveCharacter(bookId, { name: '秦九', role: '反派', personality: '张扬' });
  const chId = await db.createChapter(bookId, '第三章 夜袭');
  await db.createSection(chId, '第1节 潜入');
  await db.createSection(chId, '第2节 交锋');
  const secs = await db.listSections(chId);
  await db.saveSectionBody(secs[0].id, '夜色沉下来，灯一盏盏亮了。他翻墙而入，脚步很轻。');
  return JSON.stringify({ bookId, chId, secId: secs[0].id });
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
  await send('Runtime.evaluate', { expression: 'NOVEL_APP', returnByValue: false }).catch(() => {});

  const setupRes = await send('Runtime.evaluate', { expression: SETUP, awaitPromise: true, returnByValue: true });
  const { bookId, chId, secId } = JSON.parse(setupRes.result.value);
  console.log('setup', bookId, chId, secId);

  async function nav(hash) { await send('Runtime.evaluate', { expression: 'NOVEL_APP.go("' + hash + '")' }); await new Promise(r => setTimeout(r, 700)); }
  async function snap(file) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    console.log('saved', file);
  }

  await nav('#/book/' + bookId + '/chars'); await snap('tests/v318-chars.png');
  await nav('#/chapter/' + chId); await snap('tests/v318-chapter.png');
  await nav('#/section/' + chId + '/' + secId);
  await send('Runtime.evaluate', { expression: 'document.querySelector("#fabBtn").click()' });
  await new Promise(r => setTimeout(r, 350));
  await snap('tests/v318-section-fab.png');

  // 清理
  await send('Runtime.evaluate', { expression: '(async()=>{const db=NOVEL_DB;await db.deleteChapter(' + chId + ');const cs=await db.listCharacters(' + bookId + ');for(const c of cs)if(c.name==="林墨"||c.name==="秦九")await db.deleteCharacter(c.id);return "cleared";})()', awaitPromise: true, returnByValue: true });
  console.log('cleaned');
  ws.close();
})().catch(e => console.error('SNAP_ERR', e.message));
