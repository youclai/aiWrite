/* devtools-smoke-ui.cjs —— 真机 UI 冒烟探针（只读，不插任何业务数据）：
   1) 当前路由与页面容器是否渲染出内容
   2) 书架书目卡片数量（与 NOVEL_DB.listBooks 对照）
   3) window.onerror 捕获的 JS 错误列表（本次会话内）
   4) 返回键插件 AppBack 是否在监听链上
   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
   用法：node tests/devtools-smoke-ui.cjs */
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

  // 先挂一个错误收集器（幂等），后续读取
  console.log('=== 安装 onerror 收集器 ===');
  console.log(await evaluate("(function(){if(!window.__smokeErrs){window.__smokeErrs=[];window.addEventListener('error',function(e){window.__smokeErrs.push(String(e.message))});}return 'installed'})()"));

  console.log('=== 路由与页面渲染 ===');
  console.log(await evaluate("(function(){var v=document.querySelector('.view, #view, main, .page');var vis=[...document.querySelectorAll('section,div')].filter(function(n){return n.offsetParent!==null}).length;return JSON.stringify({hash:location.hash||'(none)',viewEl:!!v,visibleNodes:vis,title:document.title})})()"));

  console.log('=== 书架卡片 vs DB 书目（只读对照） ===');
  console.log(await evaluate("(async function(){try{var b=await window.NOVEL_DB.listBooks();var cards=[...document.querySelectorAll('li.card')].filter(function(n){return (n.getAttribute('data-open')||'').indexOf('/book/')>-1}).length;return JSON.stringify({dbBooks:b.length,domCards:cards,titles:b.map(function(x){return x.title})})}catch(e){return 'ERR '+e}})()"));

  console.log('=== AppBack 返回键链 ===');
  console.log(await evaluate("(function(){var p=window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.AppBack;return p?('AppBack ok, handleOnBackPressed='+(typeof p.handleOnBackPressed)):'AppBack ABSENT'})()"));

  console.log('=== 会话内 JS 错误 ===');
  console.log(await evaluate("JSON.stringify(window.__smokeErrs||[])"));

  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
