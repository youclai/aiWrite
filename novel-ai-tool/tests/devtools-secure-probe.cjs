/* devtools-secure-probe.cjs —— 取原生 SecureStore.getKey() 的主密钥指纹（sha256 前 16 位，不泄明文），
   跨冷启动对比是否稳定，佐证“主密钥经 Keystore 包裹 + prefs 密文持久化”。 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
async function main() {
  const targets = await (await fetch(BASE + '/json')).json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET'); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.addEventListener('message', ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const pp = pending.get(msg.id); pending.delete(msg.id); msg.error ? pp.rej(new Error(JSON.stringify(msg.error))) : pp.res(msg.result); } });
  await new Promise((ok, err) => { ws.addEventListener('open', ok); ws.addEventListener('error', err); });
  const expr = `(async function(){
    try{
      var r = await window.Capacitor.Plugins.SecureStore.getKey();
      var v = r && r.value;
      if(!v) return 'NO_VALUE '+JSON.stringify(r);
      var bytes = Uint8Array.from(atob(v), function(c){return c.charCodeAt(0)});
      var h = await crypto.subtle.digest('SHA-256', bytes);
      var hex = Array.from(new Uint8Array(h)).map(function(b){return ('0'+b.toString(16)).slice(-2)}).join('');
      return JSON.stringify({ b64len: v.length, keyBytes: bytes.length, fp: hex.slice(0,16) });
    }catch(e){ return 'getKey ERR '+((e&&(e.message||JSON.stringify(e)))||e); }
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) console.log('EXC', JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
  else console.log(r.result.value);
  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
