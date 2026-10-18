/* devtools-m7b-probe.cjs —— 定点复验两条老崩溃路径：
   1) 书架“＋新建作品”改用页面内表单弹层（旧 window.prompt 会死锁主线程）；开层后线程仍活(alive)。
      仅打开不提交，测完点取消，不写入任何业务数据。
   2) App.onBack 逐级：作品页→书架；已在书架→弹“再按一次退出”提示（单次调用不触发退出）。
   运行：node tests/devtools-m7b-probe.cjs   */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const EXPR = `(async () => {
  const g = globalThis, A = g.NOVEL_APP, out = {};
  A.go('#/shelf'); await new Promise(r=>setTimeout(r,250));
  const btn = document.querySelector('#newBook'); out.btnFound = !!btn;
  if (btn) { btn.click(); await new Promise(r=>setTimeout(r,250)); }
  const fs = document.querySelector('#formSheet');
  out.formSheetVisible = fs ? !fs.hidden : false;
  out.formSheetHasInput = fs ? !!fs.querySelector('input') : false;
  out.aliveAfterPromptPath = 1 + 1;                       // 若主线程被同步弹窗卡死，本次 evaluate 不会返回
  const cancel = fs && fs.querySelector('[data-closesheet]'); if (cancel) cancel.click();
  const bs = await g.NOVEL_DB.listBooks();
  if (bs.length) {
    A.go('#/book/' + bs[0].id + '/chars'); await new Promise(r=>setTimeout(r,250));
    out.beforeBack = location.hash;
    A.onBack(); await new Promise(r=>setTimeout(r,300));
    out.afterBack = location.hash;                          // 期望 #/shelf
    A.onBack(); await new Promise(r=>setTimeout(r,150));
    out.afterBack2 = location.hash;                         // 在书架：仍 #/shelf（单次不退出）
    const tst = document.getElementById('toast');
    out.toastText = tst ? tst.textContent : '';
  }
  return JSON.stringify(out);
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
