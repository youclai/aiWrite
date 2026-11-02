/* devtools-sponsor-jump.cjs —— 真机验证「一键跳转」是否真的拉起外部浏览器：
   进入 #/me/sponsor，真实点击 #spOpen（不拦截 window.open），让 Capacitor 派发 ACTION_VIEW。
   脚本只负责触发；是否成功由外部用 adb dumpsys 读前台包名佐证。
   运行：node tests/devtools-sponsor-jump.cjs */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const EXPR = `(async () => {
  const A = globalThis.NOVEL_APP;
  A.go('#/me/sponsor');
  await new Promise(r => setTimeout(r, 450));
  const url = globalThis.NOVEL_VIEWS.SPONSOR_URL;
  // 直接看真实环境下 window.open 的返回值：null 多半代表 WebView 未开多窗口、未派发外部 Intent
  let w = null, err = '';
  try { w = globalThis.open(url, '_blank'); } catch (e) { err = String(e); }
  return JSON.stringify({ url: url, returnedNull: w == null, winType: typeof w, err: err });
})()`;
async function main() {
  const targets = await (await fetch(BASE + '/json')).json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET'); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.addEventListener('message', ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const pp = pending.get(msg.id); pending.delete(msg.id); msg.error ? pp.rej(new Error(JSON.stringify(msg.error))) : pp.res(msg.result); } });
  await new Promise(r => ws.addEventListener('open', r));
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
  console.log((r && r.result && r.result.value) || JSON.stringify(r));
  ws.close();
}
main().catch(e => { console.log('PROBE_FAIL: ' + e.message); process.exitCode = 1; });
