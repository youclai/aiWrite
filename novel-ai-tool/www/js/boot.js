/* 启动装配：把 Capacitor SQLite 接成 db.js 需要的适配器，跑迁移，暴露自检结果
   注意：无打包器约定，插件一律取自原生注入的 window.Capacitor；裸模块 import 不可用 */
(function (root) {
  'use strict';

  var C = root.Capacitor;
  var report = { native: false, ready: false, error: '', dbInfo: null, plugins: [], secure: null, temp: null };

  // @capacitor-community/sqlite 8.x 的连接名；库文件落在应用私有目录，不外传
  var DB_NAME = 'novel';

  // @capacitor-community/sqlite v8 的全局插件对象（window.Capacitor.Plugins.CapacitorSQLite）走“选项对象”API，
  // 与 Node 侧 node:sqlite 适配器不同：query/run/execute 都吃 {database, statement, values}。
  // 这里把它包成 db.js/backup.js/storage.js 共用的 {all,run,exec} 契约（与 tests 里的 Node 适配器同形）。
  function makeAdapter(S, dbName) {
    return {
      all: function (sql, params) {
        return S.query({ database: dbName, statement: sql, values: params || [] })
          .then(function (r) { return (r && r.values) || []; });
      },
      run: function (sql, params) {
        // 参数化单条写入；插件在 SQL 出错时本身会 reject（等价旧版 throwOnError=true，写入失败不静默丢稿）
        return S.run({ database: dbName, statement: sql, values: params || [], transaction: false, returnMode: 'all' })
          .then(function (r) {
            var ch = (r && r.changes) || {};
            return { changes: Number(ch.changes || 0), lastId: Number(ch.lastId || 0) };
          });
      },
      exec: function (sql) {
        // 批量 DDL / PRAGMA / BEGIN-COMMIT：transaction:false 让上层（db.js 迁移、backup.js 恢复）自管事务，避免与插件内部事务嵌套
        return S.execute({ database: dbName, statements: sql, transaction: false }).then(function () { return true; });
      }
    };
  }

  /* ---------- 加密存储 & 暂存层适配器（原生桥拼装，缺插件即优雅降级） ---------- */

  // Uint8Array ⇄ base64：Capacitor Filesystem 写二进制靠 base64 字符串传递（WebView 内自带 atob/btoa）
  function u8ToB64(u8) {
    var CHUNK = 0x8000; var bin = '';
    for (var i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return root.btoa(bin);
  }
  function b64ToU8(b64) {
    var bin = root.atob(b64 || ''); var n = bin.length; var u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  // @capacitor/filesystem → NOVEL_TEMP 需要的适配器；根落在应用私有目录 Directory.Data
  function makeFsAdapter(Filesystem) {
    var DIR = 'data';   // Directory.Data 的字符串值，WebView 内免存储权限
    return {
      ensureDir: function (rel) {
        return Filesystem.mkdir({ path: rel, directory: DIR, recursive: true })
          .then(function () { return true; }, function () { return false; }); // 已存在会抛错，吞掉
      },
      writeFile: function (rel, content) {
        return Filesystem.writeFile({ path: rel, data: content, directory: DIR, encoding: 'utf8', recursive: true });
      },
      // 二进制：不传 encoding，data 走 base64，Filesystem 会解码后按原始字节落盘（zip/docx/备份包）
      writeBytes: function (rel, u8) {
        return Filesystem.writeFile({ path: rel, data: u8ToB64(u8), directory: DIR, recursive: true });
      },
      readFile: function (rel) {
        return Filesystem.readFile({ path: rel, directory: DIR, encoding: 'utf8' }).then(function (r) { return r && r.data; });
      },
      // 二进制读回：不指定 encoding，返回的 r.data 即 base64，转回 Uint8Array
      readBytes: function (rel) {
        return Filesystem.readFile({ path: rel, directory: DIR }).then(function (r) { return b64ToU8(r && r.data); });
      },
      exists: function (rel) {
        return Filesystem.stat({ path: rel, directory: DIR }).then(function () { return true; }, function () { return false; });
      },
      readdir: function (rel) {
        return Filesystem.readdir({ path: rel, directory: DIR }).then(function (r) {
          return (r && r.files ? r.files : []).map(function (f) { return { name: f.name, isDir: f.type === 'directory' }; });
        });
      },
      deleteFile: function (rel) { return Filesystem.deleteFile({ path: rel, directory: DIR }); },
      removeDir: function (rel) { return Filesystem.rmdir({ path: rel, directory: DIR, recursive: true }); },
      stat: function (rel) { return Filesystem.stat({ path: rel, directory: DIR }).then(function (s) { return { size: s && s.size ? Number(s.size) : 0 }; }); }
    };
  }

  // 加密存储：优先原生 SecureStore（Keystore 包钥）；无则用设备内随机密钥兜底（弱，标 caveats）
  function initSecure(Plugins) {
    if (!root.NOVEL_SECURE) return Promise.resolve({ status: 'absent' });
    if (!Plugins.Preferences) return Promise.resolve({ status: 'skipped', reason: 'Preferences 未注册' });
    var storage = root.NOVEL_SECURE.makePrefsStorage(Plugins.Preferences);
    var kp = Plugins.SecureStore && typeof Plugins.SecureStore.getKey === 'function'
      ? root.NOVEL_SECURE.keyProviderFromNative(Plugins.SecureStore)
      : root.NOVEL_SECURE.keyProviderFromLocalSecret(storage);
    var viaKeystore = !!(Plugins.SecureStore && typeof Plugins.SecureStore.getKey === 'function');
    return root.NOVEL_SECURE.init({ keyProvider: kp, storage: storage })
      // init 只挂引用不碰密钥；这里真正派生一次，Keystore 包裹不可用时不会虚报 ok
      .then(function () { return kp.getKey(); })
      .then(function () { return { status: 'ok', keySource: viaKeystore ? 'keystore' : 'device-secret（待升级 Keystore）' }; },
            function (e) { return { status: 'error', reason: (e && e.message) || String(e) }; });
  }

  function initTemp(Plugins) {
    if (!root.NOVEL_TEMP) return Promise.resolve({ status: 'absent' });
    if (!Plugins.Filesystem) return Promise.resolve({ status: 'skipped', reason: 'Filesystem 未注册' });
    return root.NOVEL_TEMP.init(makeFsAdapter(Plugins.Filesystem))
      .then(function () { return { status: 'ok', root: root.NOVEL_TEMP.ROOT, categories: root.NOVEL_TEMP.CATEGORY_LIST }; },
            function (e) { return { status: 'error', reason: (e && e.message) || String(e) }; });
  }

  function boot() {
    report.plugins = C ? Object.keys(C.Plugins || {}) : [];
    report.native = !!(C && C.isNativePlatform && C.isNativePlatform());
    if (!report.native) {
      report.error = '非原生壳（浏览器预览），SQLite 与自研插件不可用；数据层单测请在电脑用 node 跑 tests/';
      return Promise.resolve(report);
    }
    // 真机注册名是 CapacitorSQLite（@capacitor-community/sqlite v8），非 SQLite；兼容两种取法
    var SQLite = C.Plugins.CapacitorSQLite || C.Plugins.SQLite;
    if (!SQLite || typeof SQLite.createConnection !== 'function') {
      report.error = 'SQLite 插件未注册（CapacitorSQLite），请执行 cap sync 后重新构建 APK';
      return Promise.resolve(report);
    }
    // 幂等建连接：已 open 就复用；否则 createConnection→open（createConnection 对已存在连接会抛，吞掉转 open）
    function ensureConnection() {
      return Promise.resolve()
        .then(function () {
          if (typeof SQLite.isDBOpen !== 'function') return false;
          return SQLite.isDBOpen({ database: DB_NAME }).then(function (r) { return !!(r && r.result); }, function () { return false; });
        })
        .then(function (open) {
          if (open) return null;   // 连接已在，无需再建
          return Promise.resolve(SQLite.createConnection({ database: DB_NAME, version: 1, encrypted: false, mode: 'no-encryption', readonly: false }))
            .catch(function () { return null; })   // “already exists” 之类：连接已在，继续 open
            .then(function () {
              if (typeof SQLite.open !== 'function') return null;
              return Promise.resolve(SQLite.open({ database: DB_NAME })).catch(function () { return null; });
            });
        });
    }
    return ensureConnection()
      .then(function () {
        var adapter = makeAdapter(SQLite, DB_NAME);
        root.NOVEL_ADAPTER = adapter;   // 暴露裸 {all,run,exec}，供 backup.js/storage.js/dataActions.js 复用
        return root.NOVEL_DB.init(adapter);
      })
      .then(function (info) { report.dbInfo = info; report.ready = true; })
      // DB 就绪后再装配加密存储与暂存层；它们失败只记状态，绝不让整个 boot 崩（写稿主链路优先）
      .then(function () { return initSecure(C.Plugins); })
      .then(function (s) { report.secure = s; })
      .then(function () { return initTemp(C.Plugins); })
      .then(function (t) { report.temp = t; })
      .catch(function (e) { report.error = (e && (e.message || e.reallyStack || String(e))) || String(e); })
      // 无论成败都 resolve 成 report，调用方不用另取全局对象
      .then(function () { return report; });
  }

  root.NOVEL_BOOT = { report: report, boot: boot };
})(globalThis);
