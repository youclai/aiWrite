/* devtools-shelf-probe.cjs —— 现场重放 #/shelf 渲染，抓异步 DB/视图真实报错。
   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>。 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
async function main() {
  const targets = await (await fetch(BASE + '/json')).json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET'); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.addEventListener('message', ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const pp = pending.get(msg.id); pending.delete(msg.id); msg.error ? pp.reject(new Error(JSON.stringify(msg.error))) : pp.resolve(msg.result); } });
  await new Promise((ok, err) => { ws.addEventListener('open', ok); ws.addEventListener('error', err); });
  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text);
    return r.result ? r.result.value : r;
  }

  console.log('=== NOVEL_VIEWS 注册表 ===');
  console.log(await evaluate("JSON.stringify(window.NOVEL_VIEWS?Object.keys(NOVEL_VIEWS):'NO NOVEL_VIEWS')"));
  console.log('=== shelf 类型 ===');
  console.log(await evaluate("(function(){var v=window.NOVEL_VIEWS&&NOVEL_VIEWS.shelf;return v?(typeof v)+ (typeof v==='object'&&v.render?'/render='+typeof v.render:''):('shelf='+String(v))})()"));
  console.log('=== DB.info() ===');
  console.log(await evaluate("(function(){try{return JSON.stringify(window.NOVEL_DB?NOVEL_DB.info():'NO DB')}catch(e){return 'DB.info ERR '+e.message}})()"));
  console.log('=== listBooks() 结果/报错 ===');
  console.log(await evaluate("(async function(){try{var b=await NOVEL_DB.listBooks();return 'OK len='+b.length+' '+JSON.stringify(b).slice(0,200);}catch(e){return 'listBooks ERR: '+(e&&(e.message||JSON.stringify(e))||e)}})()"));
  console.log('=== 直接调用 shelf 视图并等 400ms 后 #screen ===');
  console.log(await evaluate("(async function(){try{var v=NOVEL_VIEWS.shelf;var fn=(typeof v==='function')?v:v.render;var p=fn.call(v,{});if(p&&p.then)await p;}catch(e){return 'call ERR '+e.message}await new Promise(r=>setTimeout(r,400));var el=document.getElementById('screen');return 'screenLen='+(el?el.innerHTML.length:'NOEL')+' head='+(el?el.innerHTML.slice(0,300):'')})()"));

  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
