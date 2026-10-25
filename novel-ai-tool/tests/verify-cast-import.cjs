/* verify-cast-import.cjs —— 导入后自检（只读）：
   1) 第2~6节手机正文与本地文件逐字比对（规范化去空白后全等）；
   2) 第1节封条：仍为 len=1997 / updated_at=1792782391178（与更新前一致）；
   3) 人物卡九张、势力三条：字段齐全、书名正确、aliases 可解析。
   用法：node tests/verify-cast-import.cjs */
const fs = require('fs');
const path = require('path');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const DIR = 'd:/xh/C-新书/C-第01章-童年的那顿饭';
const FILES = {
  2: 'C-第01章-第02节-东西是村长分的.txt', 3: 'C-第01章-第03节-孩子进教堂.txt',
  4: 'C-第01章-第04节-门被砸.txt', 5: 'C-第01章-第05节-门开了.txt', 6: 'C-第01章-第06节-第二天天一亮.txt'
};
function loadBody(name) {
  const lines = fs.readFileSync(path.join(DIR, name), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let k = 0;
  while (k < lines.length && !/^第\s*[0-9〇零一二三四五六七八九十百千万两]+\s*节/.test(lines[k])) k++;
  return lines.slice(k + 1).join('\n').trim();
}
const norm = s => s.replace(/\s+/g, '');
const FILE_BODY = {}; for (const i of Object.keys(FILES)) FILE_BODY[i] = norm(loadBody(FILES[i]));

const EXPR = `(async () => {
  const DB = globalThis.NOVEL_DB;
  const out = { secs: {}, guard1: {}, characters: [], factions: [] };
  const secs = await DB.listSections(25);
  for (const s of secs) {
    const full = await DB.getSection(s.id);
    out.secs[s.idx] = { title: s.title, len: String(full.body || '').replace(/\\s+/g, '').length,
      head: String(full.body || '').replace(/\\s+/g, '').slice(0, 24) };
  }
  const c1 = await DB.getSection(12);
  out.guard1 = { len: String(c1.body || '').length, updated_at: c1.updated_at };
  for (const c of await DB.listCharacters(5)) {
    let aliasOk = true; try { JSON.parse(c.aliases); } catch (e) { aliasOk = false; }
    out.characters.push({ name: c.name, role: !!c.role, gender: c.gender, age: !!c.age,
      person: !!c.personality, speech: !!c.speech_style, taboo: !!c.taboos, bg: !!c.background, aliasOk });
  }
  for (const f of await DB.listFactions(5)) out.factions.push({ name: f.name, kind: !!f.kind, intro: f.intro.length });
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
  const d = JSON.parse(val);
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log(`FAIL ${name}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
  };
  eq('第1节封条 len', d.guard1.len, 1997);
  eq('第1节封条 updated_at', d.guard1.updated_at, 1792782391178);
  for (const i of ['2', '3', '4', '5', '6']) {
    eq(`第${i}节正文逐字一致`, d.secs[i] && d.secs[i].len === FILE_BODY[i].length
      && d.secs[i].head === FILE_BODY[i].slice(0, 24), true);
  }
  eq('节数', Object.keys(d.secs).length, 6);
  eq('人物卡数', d.characters.length, 9);
  eq('势力数', d.factions.length, 3);
  eq('人物卡字段齐全', d.characters.every(c => c.role && c.age && c.person && c.speech && c.taboo && c.bg && c.aliasOk), true);
  eq('性别均为界面允许值', d.characters.every(c => ['', '男', '女', '其他', '未知'].includes(c.gender)), true);
  eq('势力字段齐全', d.factions.every(f => f.kind && f.intro >= 20), true);
  console.log(`\n[自检] 通过 ${pass} 失败 ${fail}`);
  ws.close(); process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('PROBE_ERR', e.message); process.exitCode = 2; });
