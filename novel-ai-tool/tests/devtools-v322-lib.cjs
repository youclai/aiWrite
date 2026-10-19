/* devtools-v322-lib.cjs —— v3.22 真机走查通用 CDP 驱动
 * 用法：node tests/devtools-v322-lib.cjs <表达式文件.js> [截图名]
 *   第一参数为 .js 文件路径（相对仓库根），文件内是一段 async 函数体，需 return 字符串。
 *   （用文件传参以绕开 PowerShell 对引号/管道/中文的切分问题。）
 *   可选第二参数为截图输出名（写到 tests/ 下）。
 * 依赖：Node 22+ 全局 WebSocket / fetch；adb forward tcp:9222 已建立。
 */
const fs = require('fs');
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

(async () => {
  const arg = process.argv[2];
  const shotName = process.argv[3];
  if (!arg) { console.log('USAGE: node devtools-v322-lib.cjs <exprFile.js> [shot.png]'); return; }
  let expr;
  if (arg[0] === '@') expr = arg; // 直接内联（少见）
  else expr = fs.readFileSync(arg, 'utf8');

  const list = await (await fetch(BASE + '/json')).json();
  const p = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!p) { console.log('NO_PAGE'); return; }

  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let id = 0; const pm = new Map();
  const send = (m, prm) => new Promise((r, j) => { const i = ++id; pm.set(i, { res: r, rej: j }); ws.send(JSON.stringify({ id: i, method: m, params: prm || {} })); });
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pm.has(msg.id)) { const pp = pm.get(msg.id); pm.delete(msg.id); msg.error ? pp.rej(new Error(JSON.stringify(msg.error))) : pp.res(msg.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable'); await send('Page.enable');

  const wrap = '(async () => { ' + expr + ' })()';
  const res = await send('Runtime.evaluate', { expression: wrap, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    console.log('EVAL_ERR: ' + (res.exceptionDetails.exception && res.exceptionDetails.exception.description || res.exceptionDetails.text));
  } else {
    console.log('RESULT: ' + (res.result && res.result.value));
  }

  if (shotName) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const out = 'tests/' + shotName;
    fs.writeFileSync(out, Buffer.from(s.data, 'base64'));
    console.log('saved ' + out);
  }
  ws.close();
})().catch(e => console.error('LIB_ERR', e.message));
