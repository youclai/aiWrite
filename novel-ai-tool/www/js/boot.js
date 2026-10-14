/* 启动装配：把 Capacitor SQLite 接成 db.js 需要的适配器，跑迁移，暴露自检结果
   注意：无打包器约定，插件一律取自原生注入的 window.Capacitor；裸模块 import 不可用 */
(function (root) {
  'use strict';

  var C = root.Capacitor;
  var report = { native: false, ready: false, error: '', dbInfo: null, plugins: [] };

  // @capacitor-community/sqlite 8.x 的连接名；库文件落在应用私有目录，不外传
  var DB_NAME = 'novel';

  function makeAdapter(conn) {
    return {
      all: function (sql, params) {
        return conn.query(sql, params).then(function (r) { return r.values || []; });
      },
      run: function (sql, params) {
        // throwOnError=true：写入失败必须炸出来，不能静默丢稿
        return conn.execute(sql, params, true).then(function (r) {
          // 单条 INSERT 时插件把 lastInsertRowid 放在 message（新版本亦有 lastId）
          var id = r.lastId !== undefined ? r.lastId : r.message;
          return { changes: Number(r.changes || 0), lastId: Number(id) || 0 };
        });
      },
      exec: function (sql) {
        return conn.query(sql, []).then(function () { return true; });
      }
    };
  }

  function boot() {
    report.plugins = C ? Object.keys(C.Plugins || {}) : [];
    report.native = !!(C && C.isNativePlatform && C.isNativePlatform());
    if (!report.native) {
      report.error = '非原生壳（浏览器预览），SQLite 与自研插件不可用；数据层单测请在电脑用 node 跑 tests/';
      return Promise.resolve(report);
    }
    var SQLite = C.Plugins.SQLite;
    if (!SQLite) {
      report.error = 'SQLite 插件未注册，请执行 npm run sync 后重新构建 APK';
      return Promise.resolve(report);
    }
    return (SQLite.checkConnections(DB_NAME).then(function (r) {
      // checkConnections 返回已连接名数组，命中就直接取，避免重复 create
      var connected = r && (r.connect || r);
      return (Array.isArray(connected) && connected.indexOf(DB_NAME) >= 0)
        ? null
        : SQLite.createConnection({ database: DB_NAME, version: '1.0', location: 'default', encrypted: false });
    }))
      .then(function () { return SQLite.retrieveConnection(DB_NAME); })
      .then(function (conn) { return root.NOVEL_DB.init(makeAdapter(conn)); })
      .then(function (info) { report.dbInfo = info; report.ready = true; })
      .catch(function (e) { report.error = (e && (e.message || e.reallyStack || String(e))) || String(e); })
      // 无论成败都 resolve 成 report，调用方不用另取全局对象
      .then(function () { return report; });
  }

  root.NOVEL_BOOT = { report: report, boot: boot };
})(globalThis);
