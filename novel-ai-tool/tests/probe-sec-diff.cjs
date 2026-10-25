/* probe-sec-diff.cjs —— 只读比对：手机《勇者》第1章第2/3节正文 与 本地新文件 是否同版本。
   比对方式：取手机正文与文件正文的规范化文本（去空白）各自首 60 字符、尾 60 字符、总长度。
   用法：node tests/probe-sec-diff.cjs */
const fs = require('fs');
const path = require('path');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const DIR = 'd:/xh/C-新书/C-第01章-童年的那顿饭';
const FILES = {
  2: 'C-第01章-第02节-东西是村长分的.txt',
  3: 'C-第01章-第03节-孩子进教堂.txt'
};
// 文件正文：跳过前两行标题（第一章/第二节），去 BOM/换行差异
function loadBody(name) {
  const t = fs.readFileSync(path.join(DIR, name), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = t.split('\n');
  let k = 0;
  while (k < lines.length && !/^第\s*[0-9〇零一二三四五六七八九十百千万两]+\s*节/.test(lines[k])) k++;
  return lines.slice(k + 1).join('\n').trim();
}
const norm = s => s.replace(/\s+/g, '');
const FILE_BODY = { 2: norm(loadBody(FILES[2])), 3: norm(loadBody(FILES[3])) };

const EXPR = `(async () => {
  const DB = globalThis.NOVEL_DB;
  const out = {};
  const chapters = await DB.listChapters(5);
  const ch = chapters.find(c => c.title === '童年的那顿饭');
  if (!ch) { out.error = 'CHAPTER_NOT_FOUND'; return JSON.stringify(out); }
  const secs = await DB.listSections(ch.id);
  for (const s of secs) {
    const full = await DB.getSection(s.id);
    const body = String((full && full.body) || '').replace(/\\s+/g, '');
    out['sec' + s.idx] = { id: s.id, title: s.title, len: body.length,
      head: body.slice(0, 60), tail: body.slice(-60) };
  }
  return JSON.stringify(out);
})()`;

(async () => {
  const targets = await (await fetch(BASE + '/json')).json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET'); process.exitCode = 3; return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pend.has(msg.id)) { const p = pend.get(msg.id); pend.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  const val = r && r.result && r.result.value;
  if (!val) { console.log('EVAL_FAIL', JSON.stringify(r && r.exceptionDetails)); ws.close(); process.exitCode = 4; return; }
  const phone = JSON.parse(val);
  for (const i of [2, 3]) {
    const p = phone['sec' + i], f = FILE_BODY[i];
    if (!p) { console.log(`sec${i}: PHONE_MISSING`); continue; }
    const same = p.len === f.length && p.head === f.slice(0, 60) && p.tail === f.slice(-60);
    console.log(`sec${i} [${p.title}] same=${same}`);
    console.log(`  phone len=${p.len} file len=${f.length}`);
    console.log(`  phone head: ${p.head}`);
    console.log(`  file  head: ${f.slice(0, 60)}`);
    console.log(`  phone tail: ${p.tail}`);
    console.log(`  file  tail: ${f.slice(-60)}`);
  }
  ws.close();
})().catch(e => { console.error('PROBE_ERR', e.message); process.exitCode = 2; });
