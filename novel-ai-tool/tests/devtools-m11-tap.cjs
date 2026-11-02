/* devtools-m11-tap.cjs —— CDP 派发受信任鼠标事件（走浏览器输入管线的模拟点按）
 * 用法：node tests/devtools-m11-tap.cjs <cssX> <cssY>
 * 与 Runtime.evaluate 的合成 click 不同，Input.dispatchMouseEvent 事件带用户手势标记，
 * 可用于触发需要 gesture 的 UI（本 App 内交互均可用）。
 * 注意（11/02 Magic7 真机实测）：即便受信任点按，WebView(v150) 的弹窗拦截器仍会静默拦
 * 截 window.open（真实触摸同样无 Intent），外跳一律改用 openExternal 的 location.href 链路。
 * 依赖：adb forward tcp:9222 已建立；WebView CDP 无 Input.enable 域，直接 dispatch 即可。 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const x = Number(process.argv[2]), y = Number(process.argv[3]);
if (!isFinite(x) || !isFinite(y)) { console.log('USAGE: node devtools-m11-tap.cjs <x> <y>'); process.exit(1); }

(async () => {
  const list = await (await fetch(BASE + '/json')).json();
  const p = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!p) { console.log('NO_PAGE'); process.exit(1); }
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let id = 0; const pm = new Map();
  const send = (m, prm) => new Promise((r, j) => { const i = ++id; pm.set(i, { res: r, rej: j }); ws.send(JSON.stringify({ id: i, method: m, params: prm || {} })); });
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pm.has(msg.id)) { const pp = pm.get(msg.id); pm.delete(msg.id); msg.error ? pp.rej(new Error(JSON.stringify(msg.error))) : pp.res(msg.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  // WebView 的 CDP 精简集无 Input.enable（报 -32601），直接 dispatch 即可生效
  // 一次完整点击：悬停 →按下→抬起（同一坐标）
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  console.log('TAPPED ' + x + ',' + y);
  ws.close();
})().catch(e => { console.error('LIB_ERR', e.message); process.exit(1); });
