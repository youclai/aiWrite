/* devtools-restore-backup.cjs —— 把 PC 上的备份 zip 经 CDP 注入手机 App，走 App 内
   NOVEL_DATA_ACTIONS.restoreFrom 恢复整库（版本闸+参数化重放，与界面"恢复最近备份"同一条路径）。
   用法：node tests/devtools-restore-backup.cjs <备份zip路径>
   前置：桥接包(release签名+debuggable)已安装并启动一次，adb forward tcp:9222 已做 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const fs = require('fs');

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath || !fs.existsSync(zipPath)) { console.log('USAGE: node devtools-restore-backup.cjs <zip>'); process.exit(1); }
  const b64 = fs.readFileSync(zipPath).toString('base64');

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

  console.log('=== zip b64 length: ' + b64.length + ' ===');
  console.log('=== restoreFrom ===');
  const expr = "(async function(){try{var bin=atob('" + b64 + "');var u8=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++){u8[i]=bin.charCodeAt(i)}var r=await window.NOVEL_DATA_ACTIONS.restoreFrom({adapter:window.NOVEL_ADAPTER,temp:window.NOVEL_TEMP},{bytes:u8});return 'RESTORE OK '+JSON.stringify(r)}catch(e){return 'ERR '+(e&&e.message||e)}})()";
  console.log(await evaluate(expr));

  console.log('=== 恢复后 listBooks 验证 ===');
  console.log(await evaluate("(async function(){try{var b=await window.NOVEL_DB.listBooks();return JSON.stringify({books:b.length,titles:b.map(function(x){return x.title})})}catch(e){return 'ERR '+e}})()"));

  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
