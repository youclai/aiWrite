/* devtools-sponsor-probe.cjs —— 真机验证「我的 → 赞助」页：
   1) 二维码图片是否从 assets 真正加载(naturalWidth>0)；2) 复制/一键跳转两按钮存在；
   3) 一键跳转接线(拦截 window.open 校验 URL，不真的拉起浏览器)；4) 点击二维码放大弹层；
   5) 文案红线扫描；6) 切到 #/shelf 后 .screen--dual/.me-foot 无跨路由残留。
   运行：node tests/devtools-sponsor-probe.cjs （需 force-stop+启动、pidof+forward tcp:9222 已设好）*/
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

const EXPR = `(async () => {
  const g = globalThis, A = g.NOVEL_APP, out = {};
  const q = s => document.querySelector(s);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  window.addEventListener('error', e => (out.errs = out.errs || []).push('onerror: ' + (e.message || e)));

  A.go('#/me/sponsor'); await wait(450);
  out.hash = location.hash;
  out.title = (q('.sec-head .st') || {}).textContent || '';

  // 1) 二维码图片加载
  const img = q('#qrImg');
  out.qrTag = img ? img.tagName : 'NO_EL';
  out.qrSrc = img ? (img.getAttribute('src') || '') : '';
  out.qrNaturalW = img && img.naturalWidth != null ? img.naturalWidth : -1;
  out.qrLoaded = !!(img && img.complete && img.naturalWidth > 0);

  // 2) 两个按钮
  out.copyBtn = !!q('#spCopy');
  out.openBtn = !!q('#spOpen');

  // 3) 一键跳转接线：临时拦截 window.open，点按钮看是否以正确 URL 调用，随后恢复（不真拉起浏览器）
  const realOpen = g.open; let openCalls = [];
  g.open = function (u, t) { openCalls.push({ url: u, target: t }); return {}; };
  try { q('#spOpen') && q('#spOpen').click(); } catch (e) { out.openErr = String(e); }
  await wait(120);
  g.open = realOpen;
  out.openCallCount = openCalls.length;
  out.openCallUrl = openCalls[0] ? openCalls[0].url : '';
  out.urlMatchesConst = openCalls[0] ? (openCalls[0].url === g.NOVEL_VIEWS.SPONSOR_URL) : false;

  // 4) 点击二维码 -> 放大弹层 qrSheet 可见且含放大图
  img && img.click(); await wait(200);
  const sheet = q('#qrSheet');
  out.qrSheetVisible = sheet ? !sheet.hidden : 'NO_SHEET_EL';
  out.qrSheetHasImg = !!(sheet && sheet.querySelector('img.qr-img--big'));
  if (sheet && !sheet.hidden) { const c = sheet.querySelector('[data-closesheet]'); if (c) c.click(); }
  await wait(120);

  // 5) 文案红线扫描（整页文本）
  const txt = (q('#meBody') || {}).textContent || '';
  out.bannedHits = ['购买','充值','会员','解锁','付费版','优先处理','定制开发'].filter(w => txt.indexOf(w) >= 0);

  // 6) 切走到书架，确认双栏/页脚类无残留
  A.go('#/shelf'); await wait(400);
  const scr = A.el;
  out.shelfHash = location.hash;
  out.stillDual = scr.classList.contains('screen--dual');
  out.meFootOnShelf = !!scr.querySelector('.me-foot');

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
