/* devtools-update-ch1-6.cjs —— 通过设备 App 自身的高层 DB API（与界面保存同一条代码路径），
   把《勇者》第1章「童年的那顿饭」同步到本地文件夹的最新版本。
   节清单按目录自动扫描（C-第01章-第NN节-*.txt），新增节自动追加，无需改代码：
   · 第1节（id=12）纹丝不动 —— 扫描时直接排除，结束后校验其 body_len/updated_at 未变；
   · 目录里已有对应 idx 的节 —— saveSectionMeta(标题) + saveSectionBody(正文) 就地更新；
   · 目录里新增的 idx —— createSection + saveSectionBody 追加（idx 自动排在末尾）。
   用法：
     node tests/devtools-update-ch1-6.cjs preflight   # 只解析+比对，不写库
     node tests/devtools-update-ch1-6.cjs doit        # 真正执行
   前置：App 已打开，adb forward tcp:9222 localabstract:webview_devtools_remote_<pid> 已建立。 */
const fs = require('fs');
const path = require('path');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const MODE = process.argv[2] || 'preflight';
const DIR = 'd:/xh/C-新书/C-第01章-童年的那顿饭';
const BOOK_ID = 5, CH_ID = 25, SEC1_ID = 12;

// 扫描目录取除第1节以外的全部节文件，按节号排序
function scanFiles() {
  return fs.readdirSync(DIR)
    .filter(n => /^C-第01章-第\d+节-.*\.txt$/.test(n))
    .map(n => ({ name: n, idx: parseInt(n.match(/^C-第01章-第(\d+)节/)[1], 10) }))
    .filter(f => f.idx > 1)
    .sort((a, b) => a.idx - b.idx);
}


// 解析单文件：从"第N节"标题行拆出 title 与 body（标题行后整段为正文）
function loadSec(name) {
  const t = fs.readFileSync(path.join(DIR, name), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = t.split('\n');
  let k = 0;
  while (k < lines.length && !/^第\s*[0-9〇零一二三四五六七八九十百千万两]+\s*节/.test(lines[k])) k++;
  if (k >= lines.length) throw new Error('缺少节标题: ' + name);
  const title = lines[k].replace(/^第\s*[0-9〇零一二三四五六七八九十百千万两]+\s*节[\s\u3000]*/, '').trim();
  const body = lines.slice(k + 1).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, body };
}
const SECS = scanFiles().map(f => ({ idx: f.idx, ...loadSec(f.name) }));
if (!SECS.length) { console.log('NO_SECTION_FILES_FOUND'); process.exit(6); }
const payload = JSON.stringify({ secs: SECS, bookId: BOOK_ID, chId: CH_ID, sec1Id: SEC1_ID });

const EXPR = `(async () => {
  const DB = globalThis.NOVEL_DB;
  const P = ${payload};
  const MODE = ${JSON.stringify(MODE)};
  const out = { mode: MODE };

  // 第1节封条：改前记录 body_len + updated_at，改后必须一字不动
  const sec1 = await DB.getSection(P.sec1Id);
  if (!sec1 || sec1.idx !== 1) { out.error = 'SEC1_GUARD_MISS'; return JSON.stringify(out); }
  out.sec1Stamp = { id: sec1.id, title: sec1.title, len: String(sec1.body || '').length, updated_at: sec1.updated_at };

  const secs = await DB.listSections(P.chId);
  out.beforeIdx = secs.map(s => s.idx + ':' + s.title);
  const byIdx = {}; secs.forEach(s => byIdx[s.idx] = s);
  const norm = s => String(s || '').replace(/\\s+/g, '').length;

  // 结构预演：设备侧也按去空白长度比较（与 newLen 同口径），相同则 same 不写
  out.plan = [];
  for (const f of P.secs) {
    const cur = byIdx[f.idx];
    const fileLen = f.body.replace(/\\s+/g, '').length;
    let act;
    if (!cur) act = 'create';
    else {
      const curFull = await DB.getSection(cur.id);
      act = norm(curFull.body) === fileLen ? 'same' : 'update';
    }
    out.plan.push({ idx: f.idx, title: f.title, act,
      curLen: cur ? norm((await DB.getSection(cur.id)).body) : 0, newLen: fileLen });
  }
  if (MODE !== 'doit') return JSON.stringify(out);

  // 逐项落库：走 App 自身 API；same 的节不碰
  out.done = [];
  for (const f of P.secs) {
    const cur = byIdx[f.idx];
    if (cur) {
      const full = await DB.getSection(cur.id);
      if (norm(full.body) === f.body.replace(/\\s+/g, '').length) { out.done.push({ idx: f.idx, act: 'skip-same', id: cur.id }); continue; }
      await DB.saveSectionMeta(cur.id, { title: f.title });
      const words = await DB.saveSectionBody(cur.id, f.body);
      out.done.push({ idx: f.idx, act: 'update', id: cur.id, words });
    } else {
      const id = await DB.createSection(P.chId, f.title);
      const words = await DB.saveSectionBody(id, f.body);
      out.done.push({ idx: f.idx, act: 'create', id, words });
    }
  }

  // 改后校验：第1节封条未变 + 总节数与顺序
  const sec1b = await DB.getSection(P.sec1Id);
  out.sec1Intact = String(sec1b.body || '').length === out.sec1Stamp.len && sec1b.updated_at === out.sec1Stamp.updated_at;
  const after = await DB.listSections(P.chId);
  out.afterIdx = after.map(s => s.idx + ':' + s.title + ':' + s.word_count);
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
  const res = JSON.parse(val);
  console.log(JSON.stringify(res, null, 2));
  if (res.error) { console.log('RESULT_ERROR=' + res.error); process.exitCode = 5; }
  else if (MODE === 'doit') { console.log('UPDATE_DONE items=' + res.done.length + ' sec1Intact=' + res.sec1Intact); }
  ws.close();
})().catch(e => { console.error('PROBE_ERR', e.message); process.exitCode = 2; });
