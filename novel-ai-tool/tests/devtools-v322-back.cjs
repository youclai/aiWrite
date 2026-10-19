/* devtools-v322-back.cjs —— 建议2 真机返回键端到端走查
 * 在同一条 CDP 会话内：用 A.go 导航 → 发真实系统返回键(adb keyevent 4) → 读回 hash/覆盖层/toast。
 * 依赖：adb forward tcp:9222 已建立；env ADB 指向 adb.exe。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const ADB = process.env.ADB || 'adb';
const PKG = 'com.novelai.writer';

const READ = fs.readFileSync('tests/probe-hash.js', 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(...args) {
  try { return execFileSync(ADB, args, { encoding: 'utf8' }).trim(); }
  catch (e) { return 'ADB_ERR ' + (e.message || e); }
}

(async () => {
  const list = await (await fetch(BASE + '/json')).json();
  const p = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!p) { console.log('NO_PAGE'); return; }
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let id = 0; const pm = new Map();
  const send = (m, prm) => new Promise((r, j) => { const i = ++id; pm.set(i, { res: r, rej: j }); ws.send(JSON.stringify({ id: i, method: m, params: prm || {} })); });
  ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pm.has(msg.id)) { const pp = pm.get(msg.id); pm.delete(msg.id); msg.error ? pp.rej(new Error(JSON.stringify(msg.error))) : pp.res(msg.result); } };
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');

  async function evl(body) {
    const res = await send('Runtime.evaluate', { expression: '(async () => { ' + body + ' })()', awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) return 'ERR:' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result?.value;
  }
  const read = () => evl(READ);
  function back() { adb('shell', 'input', 'keyevent', '4'); }

  const log = [];
  async function step(desc) { log.push(desc + ' => ' + await read()); }

  // 链路：#/chapter/7 → 书章节 → 书架
  await evl("globalThis.NOVEL_APP.go('#/chapter/7'); await new Promise(r=>setTimeout(r,900)); return 1;");
  await step('起点 chapter');
  back(); await sleep(1100); await step('BACK#1 (期望 book/1/chapters)');
  back(); await sleep(1100); await step('BACK#2 (期望 shelf)');

  // 顶层：单次 BACK 不退出，弹提示
  await sleep(3000); // 清 _lastBack 窗口
  back(); await sleep(700); await step('顶层单按 BACK (期望仍 shelf + 再按一次提示)');

  // 编辑器 → 章
  await evl("globalThis.NOVEL_APP.go('#/editor/1/7'); await new Promise(r=>setTimeout(r,900)); return 1;");
  await step('起点 editor');
  back(); await sleep(1100); await step('BACK (期望 chapter/7)');

  // 覆盖层优先：#/me 打开用户说明弹层，BACK 关弹层不改路由
  await evl("globalThis.NOVEL_APP.go('#/me'); await new Promise(r=>setTimeout(r,700)); var b=document.getElementById('userDocBtn'); b&&b.click(); await new Promise(r=>setTimeout(r,400)); return 1;");
  await step('me+打开用户说明弹层');
  back(); await sleep(500); await step('BACK (期望仍 me，弹层已关)');

  const txt = log.join('\n');
  fs.writeFileSync('tests/back-result.txt', txt, 'utf8');
  console.log(txt);
  ws.close();
})().catch((e) => console.error('BACK_ERR', e.message));
