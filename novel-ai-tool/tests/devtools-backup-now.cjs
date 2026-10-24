/* devtools-backup-now.cjs —— 触发 App 内"立即备份"(DA.backupNow)，整库 zip 落 temp/backup/。
   只读业务数据不改；产物文件名打印出来供 adb run-as 取回。
   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
   用法：node tests/devtools-backup-now.cjs */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

async function main() {
  const res = await fetch(BASE + '/json');
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET', JSON.stringify(targets)); return; }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  }
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
    }
  });
  await new Promise((ok, err) => { ws.addEventListener('open', ok); ws.addEventListener('error', err); });

  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text);
    return r.result ? r.result.value : r;
  }

  console.log('=== backupNow ===');
  console.log(await evaluate("(async function(){try{var r=await window.NOVEL_DATA_ACTIONS.backupNow({adapter:window.NOVEL_ADAPTER,temp:window.NOVEL_TEMP},{prefix:'manual-save',book_title:'all'});return JSON.stringify(r)}catch(e){return 'ERR '+(e&&e.message||e)}})()"));

  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
