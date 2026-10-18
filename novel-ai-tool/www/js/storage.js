/* 存储统计（F47）：汇总"库里有多少 + temp 占了多少"，供"我的/存储"页展示与清理决策。
   与 db.js/backup.js 同构——不持有连接，全靠注入 deps：
     deps.db    = { all(sql,params) }          —— 与 NOVEL_DB.init 同款适配器（App 原生 / node:sqlite）
     deps.temp  = NOVEL_TEMP（可选）           —— 有且就绪才并入 temp 占用，否则 temp:null 优雅降级
   统计口径全部来自库与文件系统本身，Node 可逐数断言一致（"数字与库/文件系统一致"）。
   只做纯聚合，不碰 DOM；视图在 pages/storage.js（需真机目视，另议）。 */
(function (root) {
  'use strict';

  var SKIP = /^(sqlite_|_fts_probe)/i;   // SQLite 内部表 + 探测残留
  var FTS_HINT = /(^|_)fts/i;            // FTS 虚表及其影子表（派生数据，不计入"你的数据"行数）

  function num(v) { return Number(v) || 0; }

  function isDataTable(name, sql) {
    if (SKIP.test(name)) return false;
    if (FTS_HINT.test(name)) return false;
    if (/VIRTUAL TABLE/i.test(String(sql || ''))) return false;
    return true;
  }

  // 真实数据表清单（含将新增的表，靠 sqlite_master 动态发现，避免硬编码漏项）
  function listTables(db) {
    return Promise.resolve(db.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL", []))
      .then(function (rows) {
        return rows.filter(function (r) { return isDataTable(r.name, r.sql); }).map(function (r) { return r.name; });
      });
  }

  // 库体积 = page_count × page_size（内存库也能取，比"文件大小"更通用）
  function dbBytes(db) {
    return Promise.all([
      Promise.resolve(db.all('PRAGMA page_count', [])),
      Promise.resolve(db.all('PRAGMA page_size', []))
    ]).then(function (r) {
      var pages = r[0] && r[0][0] ? num(Object.values(r[0][0])[0]) : 0;
      var size = r[1] && r[1][0] ? num(Object.values(r[1][0])[0]) : 0;
      return { pages: pages, pageSize: size, bytes: pages * size };
    });
  }

  // AI 用量：按 status 分组，另给 total/failed/running 便捷值
  function aiUsage(db) {
    return Promise.resolve(db.all('SELECT status, COUNT(*) AS c FROM ai_jobs GROUP BY status', []))
      .then(function (rows) {
        var byStatus = {}; var total = 0;
        rows.forEach(function (r) { byStatus[r.status] = num(r.c); total += num(r.c); });
        return {
          total: total,
          failed: byStatus.failed || 0,
          running: byStatus.running || 0,
          byStatus: byStatus
        };
      });
  }

  // 某书专属统计（书内章节/字数/快照/角色/开放伏笔与问题/失败作业）
  function bookStats(db, bookId) {
    return Promise.resolve(db.all(
      'SELECT ' +
      '(SELECT COUNT(*) FROM chapters WHERE book_id=?) AS chapters,' +
      '(SELECT COALESCE(SUM(word_count),0) FROM chapters WHERE book_id=?) AS words,' +
      '(SELECT COUNT(*) FROM snapshots WHERE book_id=?) AS snapshots,' +
      '(SELECT COUNT(*) FROM characters WHERE book_id=?) AS characters,' +
      "(SELECT COUNT(*) FROM plot_threads WHERE book_id=? AND status='open') AS open_threads," +
      "(SELECT COUNT(*) FROM consistency_issues WHERE book_id=? AND status='open') AS open_issues",
      [bookId, bookId, bookId, bookId, bookId, bookId]
    )).then(function (r) {
      var o = r[0] || {};
      return { chapters: num(o.chapters), words: num(o.words), snapshots: num(o.snapshots),
               characters: num(o.characters), openThreads: num(o.open_threads), openIssues: num(o.open_issues) };
    });
  }

  // 主聚合。opts.bookId 传则附该书明细
  function collect(deps, opts) {
    deps = deps || {}; opts = opts || {};
    var db = deps.db;
    if (!db || typeof db.all !== 'function') return Promise.reject(new Error('存储统计需要 { db: {all} } 适配器'));

    var out = { generated_at: Date.now() };
    return listTables(db)
      .then(function (tables) {
        out.tableList = tables;
        // 逐表 COUNT(*)
        var chain = Promise.resolve({});
        tables.forEach(function (t) {
          chain = chain.then(function (acc) {
            return Promise.resolve(db.all('SELECT COUNT(*) AS c FROM ' + t, [])).then(function (r) {
              acc[t] = r && r[0] ? num(Object.values(r[0])[0]) : 0;
              return acc;
            });
          });
        });
        return chain;
      })
      .then(function (counts) {
        out.tables = counts;
        out.totals = { books: counts.books || 0, chapters: counts.chapters || 0, characters: counts.characters || 0 };
        return Promise.resolve(db.all('SELECT COALESCE(SUM(word_count),0) AS w FROM chapters', []));
      })
      .then(function (w) {
        out.totals.words = w && w[0] ? num(Object.values(w[0])[0]) : 0;
        return aiUsage(db);
      })
      .then(function (ai) {
        out.ai = ai;
        return dbBytes(db);
      })
      .then(function (bytes) {
        out.database = bytes;
        // temp 占用：注入且就绪才统计，否则 null（优雅降级）
        var temp = deps.temp;
        var tempReady = temp && typeof temp.usage === 'function' && (!temp.isReady || temp.isReady());
        if (!tempReady) { out.temp = null; return; }
        return Promise.resolve(temp.usage()).then(function (u) { out.temp = u; }, function () { out.temp = null; });
      })
      .then(function () {
        if (opts.bookId != null) return bookStats(db, opts.bookId).then(function (b) { out.book = b; });
      })
      .then(function () { return out; });
  }

  root.NOVEL_STORAGE = {
    collect: collect,
    _internal: { isDataTable: isDataTable, listTables: listTables, dbBytes: dbBytes, aiUsage: aiUsage, bookStats: bookStats }
  };
})(globalThis);
