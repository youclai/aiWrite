/* devtools-m8-probe.cjs —— 复现用户报的三个问题：
   1) 点"＋ 创建第一章"后是否冻结（hash 是否切到 editor、editor 是否渲染）
   2) 人物 sheetForm 保存后是否自动关闭
   3) 取消按钮点击是否关闭弹层
   运行：node tests/devtools-m8-probe.cjs */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const EXPR = `(async () => {
  const g = globalThis, A = g.NOVEL_APP, out = { steps: [], errs: [] };
  window.addEventListener('error', e => out.errs.push('onerror: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', e => out.errs.push('reject: ' + (e.reason && (e.reason.message || e.reason))));

  const bs = await g.NOVEL_DB.listBooks();
  if (!bs.length) return JSON.stringify({ ERR: 'no books' });
  const bookId = bs[0].id;

  // === TEST 1: 创建章节 ===
  A.go('#/book/' + bookId + '/chapters'); await new Promise(r=>setTimeout(r,400));
  const newChBtn = document.querySelector('#newCh');
  out.t1_btnFound = !!newChBtn;
  out.t1_btnText = newChBtn ? newChBtn.textContent.trim() : '';
  if (newChBtn) {
    newChBtn.click();
    await new Promise(r=>setTimeout(r,1000));
    out.t1_hash = location.hash;
    const edBody = document.querySelector('.ta');
    out.t1_editorRendered = !!edBody;
    out.t1_screenSnippet = A.el ? (A.el.textContent||'').replace(/\\s+/g,' ').slice(0,80) : '';
    // go back to book for next test
    A.go('#/book/' + bookId + '/chapters'); await new Promise(r=>setTimeout(r,400));
  }

  // === TEST 2: 人物 sheetForm 取消按钮 ===
  A.go('#/book/' + bookId + '/chars'); await new Promise(r=>setTimeout(r,400));
  const addChar = document.querySelector('#addChar');
  out.t2_btnFound = !!addChar;
  if (addChar) {
    addChar.click();
    await new Promise(r=>setTimeout(r,300));
    const fs = document.querySelector('#formSheet');
    out.t2_sheetVisible = fs ? !fs.hidden : 'NO_EL';
    // 找取消按钮
    const cancelBtn = fs ? fs.querySelector('.panel [data-closesheet]') : null;
    out.t2_cancelFound = !!cancelBtn;
    out.t2_cancelTag = cancelBtn ? cancelBtn.tagName : '';
    if (cancelBtn) {
      cancelBtn.click();
      await new Promise(r=>setTimeout(r,200));
      out.t2_afterCancelHidden = fs.hidden;
    }
  }

  // === TEST 3: 人物 sheetForm 保存后自动关闭 ===
  A.go('#/book/' + bookId + '/chars'); await new Promise(r=>setTimeout(r,400));
  const addChar2 = document.querySelector('#addChar');
  if (addChar2) {
    addChar2.click();
    await new Promise(r=>setTimeout(r,300));
    const fs2 = document.querySelector('#formSheet');
    out.t3_sheetVisible = fs2 ? !fs2.hidden : 'NO_EL';
    // 填名字
    const nameInput = fs2 ? fs2.querySelector('[data-fi="0"]') : null;
    if (nameInput) nameInput.value = '探针测试人物_删除我';
    const okBtn = fs2 ? fs2.querySelector('[data-sfok]') : null;
    out.t3_okFound = !!okBtn;
    if (okBtn) {
      okBtn.click();
      await new Promise(r=>setTimeout(r,800));
      out.t3_afterSaveHidden = fs2 ? fs2.hidden : 'GONE';
      // 清理：删除测试数据
      const chars = await g.NOVEL_DB.listCharacters(bookId);
      const test = chars.find(c => c.name === '探针测试人物_删除我');
      if (test) await g.NOVEL_DB.deleteCharacter(test.id);
      out.t3_cleaned = !!test;
    }
  }

  // === TEST 4: 势力/剧情 同样检查取消 ===
  A.go('#/book/' + bookId + '/faction'); await new Promise(r=>setTimeout(r,400));
  const addFac = document.querySelector('#addFac');
  out.t4_facBtnFound = !!addFac;
  if (addFac) {
    addFac.click(); await new Promise(r=>setTimeout(r,300));
    const fs4 = document.querySelector('#formSheet');
    out.t4_sheetVisible = fs4 ? !fs4.hidden : 'NO_EL';
    const cancel4 = fs4 ? fs4.querySelector('.panel [data-closesheet]') : null;
    out.t4_cancelFound = !!cancel4;
    if (cancel4) { cancel4.click(); await new Promise(r=>setTimeout(r,200)); out.t4_afterCancelHidden = fs4.hidden; }
  }

  return JSON.stringify(out, null, 2);
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
