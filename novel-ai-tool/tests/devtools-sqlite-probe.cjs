/* devtools-sqlite-probe.cjs —— 现场验证 @capacitor-community/sqlite 在设备上的正确入口与方法。
   目的：确认把 boot.js 里的 C.Plugins.SQLite 改成 CapacitorSQLite 后，
   createConnection/retrieveConnection/query/execute 这条链是否真的能跑通（改前坐实，免反复装机）。 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

async function main() {
  const res = await fetch(BASE + '/json');
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET'); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  });
  await new Promise((ok, err) => { ws.addEventListener('open', ok); ws.addEventListener('error', err); });

  const expr = `(async function(){
    var P=window.Capacitor&&Capacitor.Plugins, out={};
    var S=P.CapacitorSQLite;
    if(!S) return 'NO CapacitorSQLite';
    out.ownKeys=Object.keys(S);
    out.proto=Object.getOwnPropertyNames(Object.getPrototypeOf(S)||{});
    out.api={ checkConnections:typeof S.checkConnections, createConnection:typeof S.createConnection, retrieveConnection:typeof S.retrieveConnection, isConnection:typeof S.isConnection };
    try{
      var DB='novel';
      try{ await S.closeConnection({database:DB}); }catch(ce){}
      await S.createConnection({database:DB, version:1, encrypted:false, mode:'no-encryption', readonly:false});
      out.created=true;
      try{ await S.open({database:DB}); out.opened=true; }catch(oe){ out.openErr=(oe&&oe.message)||String(oe); }
      var q=await S.query({database:DB, statement:'SELECT 1 AS x', values:[]});
      out.queryRes=JSON.stringify(q);
      await S.execute({database:DB, statements:'CREATE TABLE IF NOT EXISTS _probe(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);', transaction:false});
      out.tableCreated=true;
      var r=await S.run({database:DB, statement:'INSERT INTO _probe(v) VALUES(?)', values:['ok'], transaction:false, returnMode:'all'});
      out.runRes=JSON.stringify(r);
      var q2=await S.query({database:DB, statement:'SELECT id,v FROM _probe', values:[]});
      out.readBack=JSON.stringify(q2);
      await S.execute({database:DB, statements:'DROP TABLE _probe;', transaction:false});
    }catch(err){ out.error=(err&&(err.message||err.reallyStack||JSON.stringify(err)))||String(err); }
    return JSON.stringify(out);
  })()`;

  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) console.log('EXC', JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
  else console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
