/* devtools-probe.cjs —— 通过 WebView 远程调试口读取设备里 App 的 JS 运行时状态。
   用途：MagicOS 把 logcat 全屏蔽（只吐 HKS 加密横幅），改从 DevTools 协议直接 evaluate，
   读 NOVEL_BOOT.report（boot 错误）+ Capacitor.Plugins（确认 AiStream/SecureStore 是否注册）。
   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid> 已做好。
   Node 22 自带 fetch + 全局 WebSocket，零依赖。 */
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

  console.log('=== Capacitor.Plugins keys ===');
  console.log(await evaluate("JSON.stringify(Object.keys((window.Capacitor&&Capacitor.Plugins)||{}))"));

  console.log('=== NOVEL_BOOT.report ===');
  console.log(await evaluate("JSON.stringify(window.NOVEL_BOOT&&NOVEL_BOOT.report||'NO NOVEL_BOOT')"));

  console.log('=== secure state ===');
  console.log(await evaluate("(function(){try{return JSON.stringify(window.NOVEL_SECURE?NOVEL_SECURE.state():'NO SECURE')}catch(e){return 'ERR '+e}})()"));

  console.log('=== AiStream plugin surface ===');
  console.log(await evaluate("(function(){var p=window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.AiStream;return p?('start='+(typeof p.start)+' cancel='+(typeof p.cancel)+' addListener='+(typeof p.addListener)):'AiStream ABSENT'})()"));

  console.log('=== SecureStore plugin surface ===');
  console.log(await evaluate("(function(){var p=window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.SecureStore;return p?('getKey='+(typeof p.getKey)):'SecureStore ABSENT'})()"));

  // 现场重放一次建库，抓真正的抛错文案（比 toast 的泛化提示精确）
  console.log('=== retry boot() live ===');
  console.log(await evaluate("(async function(){try{var rep=await NOVEL_BOOT.boot();return JSON.stringify(rep);}catch(e){return 'BOOT THROW: '+(e&&e.message||e)}})()"));

  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
