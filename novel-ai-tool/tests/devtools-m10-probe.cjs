/* devtools-m10-probe.cjs —— 优化批次（A-G）真机验收探针：
   1) boot 报告（建库/迁移是否成功）
   2) dbInfo 版本闸：toVersion 应为 7（v6 老库真机升 v7 + gender/age 列）
   3) 新模块加载：NOVEL_TEXTNORM / NOVEL_UNDO / NOVEL_DOCX.extractText / DA.readDocument
   4) DecompressionStream 是否存在（真机 docx DEFLATE 解压的前提）
   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
   用法：node tests/devtools-m10-probe.cjs */
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

  console.log('=== NOVEL_BOOT.report ===');
  console.log(await evaluate("JSON.stringify(window.NOVEL_BOOT&&NOVEL_BOOT.report||'NO NOVEL_BOOT')"));

  console.log('=== db info (期望 fromVersion<=7, toVersion=7) ===');
  console.log(await evaluate("(function(){try{var i=window.NOVEL_DB&&NOVEL_DB.info&&NOVEL_DB.info();return JSON.stringify(i||'NO info')}catch(e){return 'ERR '+e}})()"));

  console.log('=== 新模块加载面 ===');
  console.log(await evaluate("(function(){var T=window.NOVEL_TEXT_NORM,U=window.NOVEL_UNDO,D=window.NOVEL_DOCX,Z=window.NOVEL_ZIP,DA=window.NOVEL_DATA_ACTIONS,UU=window.NOVEL_UTIL;return JSON.stringify({textnorm:!!(T&&T.normalize),mapToClean:!!(UU&&UU.mapToClean),undo:!!(U&&U.create),extractText:!!(D&&D.extractText),readDocument:!!(DA&&DA.readDocument),listAsync:!!(Z&&Z.listAsync)})})()"));

  console.log('=== DecompressionStream deflate-raw 支持（真机 docx 前提） ===');
  console.log(await evaluate("(function(){try{if(typeof DecompressionStream==='undefined')return 'ABSENT';var ds=new DecompressionStream('deflate-raw');return 'OK deflate-raw'}catch(e){return 'FAIL '+e}})()"));

  // 只读验证：列存在性经 info()=v7 已证；这里取已有角色看 gender/age 字段是否随迁移读出（不插任何数据）
  console.log('=== characters gender/age 只读回检 ===');
  console.log(await evaluate("(async function(){try{var b=await window.NOVEL_DB.listBooks();if(!b.length)return 'NO_BOOKS(跳过)';var c=await window.NOVEL_DB.listCharacters(b[0].id);return JSON.stringify({books:b.length,chars:c.length,hasFields:c.length?(('gender' in c[0])&&('age' in c[0])):'(首书无人物,迁移由 toVersion=7 佐证)'})}catch(e){return 'ERR '+e}})()"));

  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
