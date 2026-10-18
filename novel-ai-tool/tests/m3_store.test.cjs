/* M3 存储层测试：加密存储 secureStore.js + 二次产物暂存 tempStore.js
   全程用 Node 22 的 Web Crypto（与 Capacitor WebView 同一份代码路径），验证：
   - 敏感信息只以 AES-GCM 密文落盘，明文绝不进 storage；篡改/换名/AAD 绑定都能拒
   - 掩码只露尾位；listSecrets 只回条目名；redact 能从日志里剥掉密钥明文
   - temp/ 根唯一、分类子目录、路径越界防护（..、绝对路径、盘符、未知分类一律拒）
   - boot 装配：缺 Preferences/Filesystem 时优雅降级，不拖垮主链路
   运行：node tests/m3_store.test.cjs   （结果写 tests/report-m3.txt，规避 GBK 控制台乱码） */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

for (const f of ['schema.js', 'db.js', 'secureStore.js', 'tempStore.js', 'boot.js']) {
  eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', f), 'utf8'));
}
const SEC = globalThis.NOVEL_SECURE;
const TMP = globalThis.NOVEL_TEMP;

/* ---------- 断言工具 ---------- */
let pass = 0, fail = 0;
const lines = [];
function log(s) { lines.push(s); }
async function check(name, fn) {
  try { await fn(); pass++; log('PASS  ' + name); }
  catch (e) { fail++; log('FAIL  ' + name + '  ::  ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }
function eq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' 期望 ' + JSON.stringify(b) + ' 实得 ' + JSON.stringify(a));
}
async function throwsAsync(fn, msgPart) {
  let threw = false, e;
  try { await fn(); } catch (err) { threw = true; e = err; }
  assert(threw, '本应抛错但没抛' + (msgPart ? '（' + msgPart + '）' : ''));
  if (msgPart) assert(String(e.message).indexOf(msgPart) >= 0, '错误信息不含"' + msgPart + '"，实得：' + e.message);
}

/* ---------- 加密存储：raw-bytes 密钥 + 内存 storage ---------- */
function fixedKey() { const k = new Uint8Array(32); for (let i = 0; i < 32; i++) k[i] = i + 1; return k; }
function freshSecure() {
  const storage = SEC.makeMemoryStorage();
  return SEC.init({ keyProvider: SEC.keyProviderFromRawBytes(() => fixedKey()), storage })
    .then(() => storage);
}

/* ---------- 暂存层：Node fs 适配器，根 = 系统临时目录下的一个 appdata ---------- */
function makeNodeFs(rootDir) {
  const abs = rel => path.join(rootDir, rel);
  return {
    ensureDir: rel => { fs.mkdirSync(abs(rel), { recursive: true }); return true; },
    writeFile: (rel, content) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), content, 'utf8'); },
    readFile: rel => fs.readFileSync(abs(rel), 'utf8'),
    exists: rel => fs.existsSync(abs(rel)),
    readdir: rel => fs.readdirSync(abs(rel), { withFileTypes: true }).map(d => ({ name: d.name, isDir: d.isDirectory() })),
    deleteFile: rel => { fs.rmSync(abs(rel), { force: true }); },
    removeDir: rel => { fs.rmSync(abs(rel), { recursive: true, force: true }); },
    stat: rel => ({ size: fs.statSync(abs(rel)).size })
  };
}

/* ---------- boot 用假原生桥（SQLite + Preferences 内存桩，Filesystem 缺失） ---------- */
function fakeCapForBoot(d) {
  let connected = false;
  const norm = (p) => (p || []).map(x => x === undefined ? null : x);
  const SQLite = {
    createConnection: () => { connected = true; return Promise.resolve(); },
    open: () => Promise.resolve(),
    isDBOpen: () => Promise.resolve({ result: connected }),
    closeConnection: () => { connected = false; return Promise.resolve(); },
    query: (opt) => { const p = norm(opt.values); return Promise.resolve({ values: p.length ? d.prepare(opt.statement).all(...p) : d.prepare(opt.statement).all() }); },
    run: (opt) => { const p = norm(opt.values); const r = p.length ? d.prepare(opt.statement).run(...p) : d.prepare(opt.statement).run(); return Promise.resolve({ changes: { changes: Number(r.changes), lastId: Number(r.lastInsertRowid), values: [] } }); },
    execute: (opt) => { d.exec(opt.statements); return Promise.resolve({ changes: { changes: 0 } }); }
  };
  const mem = new Map();
  const Preferences = {
    get: ({ key }) => Promise.resolve({ value: mem.has(key) ? mem.get(key) : null }),
    set: ({ key, value }) => { mem.set(key, String(value)); return Promise.resolve(); },
    remove: ({ key }) => { mem.delete(key); return Promise.resolve(); },
    keys: () => Promise.resolve({ keys: Array.from(mem.keys()) })
  };
  return { isNativePlatform: () => true, Plugins: { CapacitorSQLite: SQLite, Preferences }, _mem: mem };
}

(async function run() {
  log('M3 存储层测试  ' + new Date().toISOString());
  log('');

  /* ===== 1. secureStore 基础与铁律 ===== */
  await check('未 init 就读写要报"未就绪"', async () => {
    const s = SEC.makeMemoryStorage();
    await throwsAsync(() => SEC.setSecret('x', 'v'), '未就绪');
    void s;
  });

  await check('setSecret/getSecret 明文往返一致', async () => {
    await freshSecure();
    const key = 'sk-abcdef1234567890';
    await SEC.setSecret('api_key', key);
    eq(await SEC.getSecret('api_key'), key);
  });

  await check('落盘的是密文信封，storage 里查不到明文', async () => {
    const storage = await freshSecure();
    await SEC.setSecret('api_key', 'supersecret-token-xyz');
    const raw = await storage.getItem('sec:api_key');
    assert(raw && raw.indexOf('supersecret-token-xyz') < 0, '密文里出现了明文！');
    const env = JSON.parse(raw);
    eq(env.alg, 'AES-GCM'); eq(env.v, 1);
    assert(env.iv && env.ct, '信封缺 iv/ct');
  });

  await check('同名两次写入产生不同密文（随机 IV），但都能解回最新值', async () => {
    const storage = await freshSecure();
    await SEC.setSecret('k', 'same-plaintext');
    const c1 = await storage.getItem('sec:k');
    await SEC.setSecret('k', 'same-plaintext');
    const c2 = await storage.getItem('sec:k');
    assert(c1 !== c2, '两次密文相同，IV 没随机');
    eq(await SEC.getSecret('k'), 'same-plaintext');
  });

  await check('篡改密文 → 解密失败（GCM 认证）', async () => {
    const storage = await freshSecure();
    await SEC.setSecret('k', 'hello-world-1234');
    const env = JSON.parse(await storage.getItem('sec:k'));
    env.ct = env.ct.slice(0, -6) + 'AAAAAA';
    await storage.setItem('sec:k', JSON.stringify(env));
    await throwsAsync(() => SEC.getSecret('k'), '解密失败');
  });

  await check('把 A 项密文改名塞给 B 项 → AAD 绑定使其解密失败', async () => {
    const storage = await freshSecure();
    await SEC.setSecret('alpha', 'value-alpha-9999');
    const envA = await storage.getItem('sec:alpha');
    await storage.setItem('sec:beta', envA);            // 直接拷贝，不改 ct
    await throwsAsync(() => SEC.getSecret('beta'), '解密失败');
  });

  await check('getMasked 只露尾 4 位，其余打码', async () => {
    await freshSecure();
    await SEC.setSecret('api_key', 'sk-proj-ABCDEFGH9012');
    const m = await SEC.getMasked('api_key');
    assert(m.indexOf('\u2022') >= 0, '未见掩码字符');
    assert(m.endsWith('9012') && m.indexOf('ABCDEFGH') < 0, '掩码泄露过多：' + m);
  });

  await check('listSecrets 只回条目名，绝不回明文/密文值', async () => {
    const storage = await freshSecure();
    await SEC.setSecret('api_key', 'v1-aaaaaaaa');
    await SEC.setSecret('anthropic_key', 'v2-bbbbbbbb');
    const names = await SEC.listSecrets();
    eq(names, ['anthropic_key', 'api_key']);
    const rawAll = JSON.stringify(await Promise.all(names.map(n => storage.getItem('sec:' + n))));
    assert(rawAll.indexOf('v1-aaaaaaaa') < 0 && rawAll.indexOf('v2-bbbbbbbb') < 0, 'listSecrets 路径泄露明文');
  });

  await check('removeSecret 后 hasSecret=false、getSecret=null', async () => {
    await freshSecure();
    await SEC.setSecret('tmp', 'zzz-12345678');
    assert(await SEC.hasSecret('tmp'), '写后应存在');
    await SEC.removeSecret('tmp');
    eq(await SEC.hasSecret('tmp'), false);
    eq(await SEC.getSecret('tmp'), null);
  });

  await check('redact 从日志文本里剥掉所有已存密钥明文', async () => {
    await freshSecure();
    await SEC.setSecret('api_key', 'sk-LEAKME-0000');
    await SEC.setSecret('second', 'topsecret-777');
    const logline = '请求失败 Authorization: Bearer sk-LEAKME-0000 ; note=topsecret-777 done';
    const out = await SEC.redact(logline);
    assert(out.indexOf('sk-LEAKME-0000') < 0, '未脱敏 api_key');
    assert(out.indexOf('topsecret-777') < 0, '未脱敏 second');
    assert(out.indexOf('[\u5df2\u8131\u654f]') >= 0, '未见脱敏占位');
  });

  await check('设备内随机密钥兜底：首次生成并持久化 dk:master，可往返', async () => {
    const storage = SEC.makeMemoryStorage();
    await SEC.init({ keyProvider: SEC.keyProviderFromLocalSecret(storage), storage });
    await SEC.setSecret('k', 'round-via-device-key');
    eq(await SEC.getSecret('k'), 'round-via-device-key');
    assert(await storage.getItem('dk:master'), '未持久化设备主密钥');
  });

  /* ===== 2. tempStore 暂存约束 ===== */
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-m3-'));
  await check('init 建好 temp/ 根下全部分类目录', async () => {
    await TMP.init(makeNodeFs(tmpRoot));
    for (const c of TMP.CATEGORY_LIST) assert(fs.existsSync(path.join(tmpRoot, 'temp', c)), '缺目录 ' + c);
    eq(TMP.ROOT, 'temp');
  });

  await check('write/read 往返，且文件确实落在 temp/<分类>/ 下', async () => {
    const p = await TMP.write('novels', 'ch01.txt', '第一章正文……');
    eq(p, 'temp/novels/ch01.txt');
    assert(fs.existsSync(path.join(tmpRoot, p)), '未落盘: ' + p);
    eq(await TMP.read('novels', 'ch01.txt'), '第一章正文……');
  });

  await check('拒绝越出 temp/ 根：.. / 绝对路径 / 盘符 / 未知分类', async () => {
    await throwsAsync(() => TMP.write('novels', '../evil.txt'), '越界');
    await throwsAsync(() => TMP.write('novels', '..\\evil.txt'), '越界');
    await throwsAsync(() => TMP.write('novels', '/etc/passwd'), '分隔符开头');
    await throwsAsync(() => TMP.write('novels', 'C:\\Windows\\x'), '盘符');
    await throwsAsync(() => TMP.write('secrets', 'x.txt'), '未知暂存分类');
  });

  await check('子路径归类合法（temp/ai/preview/x），但不允许越过 temp 根', async () => {
    const p = await TMP.write('ai', 'draft/run1.txt', 'AI 中间结果');
    eq(p, 'temp/ai/draft/run1.txt');
    assert(fs.existsSync(path.join(tmpRoot, p)));
  });

  await check('list 只列文件、忽略子目录；不存在目录视作空', async () => {
    await TMP.write('characters', 'hero.json', '{"name":"李四"}');
    const arr = await TMP.list('characters');
    assert(arr.some(f => f.name === 'hero.json'), '未列出 hero.json');
    assert(arr.every(f => !f.isDir), 'list 不应返回目录');
    const empty = await TMP.list('preview');
    assert(Array.isArray(empty), '空分类应返回数组');
  });

  await check('usage 统计各分类文件数与字节数', async () => {
    const u = await TMP.usage();
    eq(u.root, 'temp');
    assert(u.byCategory.novels && u.byCategory.novels.files >= 1, 'novels 未计入');
    assert(u.byCategory.characters.files >= 1 && u.byCategory.characters.bytes > 0, 'characters 统计异常');
    assert(u.total.bytes >= 0 && u.total.files >= 2, '总量异常: ' + JSON.stringify(u.total));
  });

  await check('clearCategory 清空单类、clearAll 清空整个 temp 且保留根', async () => {
    await TMP.clearCategory('characters');
    eq((await TMP.list('characters')).length, 0);
    await TMP.write('export', 'book.zip', 'PK\x03\x04');
    await TMP.clearAll();
    assert(fs.existsSync(path.join(tmpRoot, 'temp')), 'temp 根应保留');
    assert(fs.existsSync(path.join(tmpRoot, 'temp', 'export')), 'clearAll 后分类应重建');
    eq((await TMP.list('export')).length, 0);
  });

  /* ===== 3. boot 装配降级 ===== */
  await check('boot（原生但缺 Filesystem/SecureStore）：secure=ok(设备密钥兜底)、temp=skipped', async () => {
    const d = new DatabaseSync(':memory:');
    globalThis.Capacitor = fakeCapForBoot(d);
    eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'boot.js'), 'utf8'));
    const r = await globalThis.NOVEL_BOOT.boot();
    assert(r.ready, '主数据层未就绪, error=' + r.error);
    eq(r.secure.status, 'ok');
    eq(r.secure.keySource, 'device-secret（待升级 Keystore）');
    eq(r.temp.status, 'skipped');
    // 装好的加密存储应真能用
    await SEC.setSecret('boot_key', 'boot-secret-value');
    eq(await SEC.getSecret('boot_key'), 'boot-secret-value');
    // Preferences 桩里存的必须是密文，不含明文
    const raw = globalThis.Capacitor._mem.get('sec:boot_key');
    assert(raw && raw.indexOf('boot-secret-value') < 0, 'Preferences 里出现明文！');
  });

  await check('boot（浏览器预览，无原生）：secure/temp 均不阻断，主链路优雅退让', async () => {
    delete globalThis.Capacitor;
    eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'boot.js'), 'utf8'));
    const r = await globalThis.NOVEL_BOOT.boot();
    eq(r.native, false); eq(r.ready, false);
  });

  log('');
  log('合计：' + pass + ' 通过 / ' + fail + ' 失败');
  fs.writeFileSync(path.join(__dirname, 'report-m3.txt'), lines.join('\n') + '\n', 'utf8');
  console.log(lines.filter(l => l.startsWith('FAIL')).join('\n') || '（无失败项）');
  console.log('M3 ' + pass + ' passed, ' + fail + ' failed  -> tests/report-m3.txt');
  process.exitCode = fail ? 1 : 0;
})().catch(e => {
  console.error('测试脚本崩溃：', e);
  fs.writeFileSync(path.join(__dirname, 'report-m3.txt'), lines.join('\n') + '\nCRASH ' + e.stack, 'utf8');
  process.exitCode = 2;
});
