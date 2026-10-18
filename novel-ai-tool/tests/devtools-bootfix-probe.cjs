/* devtools-bootfix-probe.cjs —— 上线前坐实 boot.js 适配器改法 + FTS5 可用性。
   直接在设备里按将要写进 boot.js 的 all/run/exec 映射跑一遍迁移原语：
   PRAGMA user_version、手动 BEGIN/COMMIT（经 execute）、run 参数化插入取 lastId、FTS5 trigram 探测。
   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>。 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';

async function main() {
  const res = await fetch(BASE + '/json');
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET'); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.addEventListener('message', ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); } });
  await new Promise((ok, err) => { ws.addEventListener('open', ok); ws.addEventListener('error', err); });

  const expr = `(async function(){
    var S=window.Capacitor.Plugins.CapacitorSQLite, DB='novel', out={};
    try{ await S.closeConnection({database:DB}); }catch(e){}
    try{ await S.createConnection({database:DB,version:1,encrypted:false,mode:'no-encryption',readonly:false}); }
    catch(e){ out.createNote=(e&&e.message)||String(e); }
    try{ await S.open({database:DB}); }catch(e){ out.openNote=(e&&e.message)||String(e); }
    function all(sql,p){ return S.query({database:DB,statement:sql,values:p||[]}).then(function(r){return (r&&r.values)||[]}); }
    function run(sql,p){ return S.run({database:DB,statement:sql,values:p||[],transaction:false,returnMode:'all'}).then(function(r){var c=(r&&r.changes)||{};return {changes:Number(c.changes||0),lastId:Number(c.lastId||0)};}); }
    function exec(sql){ return S.execute({database:DB,statements:sql,transaction:false}); }
    try{
      out.uv=JSON.stringify(await all('PRAGMA user_version',[]));
      await exec('BEGIN');
      await exec('DROP TABLE IF EXISTS _mprobe');
      await exec('CREATE TABLE _mprobe(id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT)');
      out.insert=JSON.stringify(await run('INSERT INTO _mprobe(t) VALUES(?)',['a']));
      await exec('COMMIT');
      out.read=JSON.stringify(await all('SELECT id,t FROM _mprobe',[]));
      try{ await exec('DROP TABLE IF EXISTS _ftsp'); }catch(e){}
      try{ await exec("CREATE VIRTUAL TABLE _ftsp USING fts5(x, tokenize='trigram')"); out.ftsTrigram='OK'; await exec('DROP TABLE _ftsp'); }
      catch(e){ out.ftsTrigram='FAIL:'+(((e&&e.message)||e)+'').slice(0,120); }
      await exec('DROP TABLE IF EXISTS _mprobe');
    }catch(err){ out.fatal=(err&&(err.message||err.reallyStack||JSON.stringify(err)))||String(err); }
    return JSON.stringify(out);
  })()`;

  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) console.log('EXC', JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
  else console.log(r.result.value);
  ws.close();
}
main().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
