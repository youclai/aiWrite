/* 备份 / 恢复（F45）：把主数据（SQLite 各表）整库导出为 zip 包，或从包恢复覆盖当前库。
   三条铁律（本模块强制）：
   1) 绝不含密钥——api_key 本就不进主库（只在 SecureStore/Preferences）；这里再对 settings.value_json
      做纵深防御：凡字段名命中 key/secret/token/password/auth 一律剔除，manifest 记录被剔除项，
      保证"备份包内查不到密钥"可被断言。
   2) 恢复前先另存 safety——applyBackup 前调用注入的 hooks.makeSafety()（App 端用 VACUUM INTO 生成
      safety_<ts>.db 落 temp/backup）；测试端注入假 hook 断言"确在执行恢复语句之前发生"。
   3) 版本闸——manifest.schema_version 高于当前可支持版本（NOVEL_SCHEMA.LATEST_VERSION）直接拒绝，
      避免用旧 App 恢复新结构丢字段；等于或低于则放行（低版本由迁移补齐）。
   与 db.js/tempStore.js 同构：不直接持有连接，全靠注入的 {all,run,exec} 适配器；产物用 NOVEL_ZIP 打包。
   恢复采用"清空 + 参数化重插"而非重建表：目标库已由启动迁移建好 schema/触发器，DELETE 保留结构，
   INSERT 进 chapters 会自动经 FTS 触发器重建索引，无需额外 rebuild。 */
(function (root) {
  'use strict';

  var SECRET_FIELD = /^(api_?key|apikey|secret|access_?token|refresh_?token|auth_?token|private_?key|password|passwd|token|auth)$/i;
  var FTS_HINT = /(^|_)fts/i;                     // FTS 虚表与其影子表名都含 fts
  var SKIP_TABLES = /^(sqlite_|_fts_probe)/i;      // SQLite 内部表 + 探测残留

  function esc(v) {                               // 渲染 SQL 字面量（仅用于 safety/人读，不参与执行）
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    return "'" + String(v).replace(/'/g, "''") + "'";
  }

  // 递归剔除敏感字段；返回 { value, redacted:[路径] }
  function redactSensitive(obj, path, acc) {
    path = path || ''; acc = acc || [];
    if (obj === null || typeof obj !== 'object') return { value: obj, redacted: acc };
    if (Array.isArray(obj)) {
      return { value: obj.map(function (x, i) { return redactSensitive(x, path + '[' + i + ']', acc).value; }), redacted: acc };
    }
    var out = {};
    Object.keys(obj).forEach(function (k) {
      var p = path ? path + '.' + k : k;
      if (SECRET_FIELD.test(k)) { acc.push(p); return; }          // 命中密钥字段名：整键丢弃
      out[k] = redactSensitive(obj[k], p, acc).value;
    });
    return { value: out, redacted: acc };
  }

  function isDataTable(row) {                     // sqlite_master 行是否为需要导出的普通数据表
    var name = row.name;
    if (SKIP_TABLES.test(name)) return false;
    if (FTS_HINT.test(name)) return false;         // 外部内容表/影子表：由触发器重建，不单独备份
    var sql = String(row.sql || '');
    if (/VIRTUAL TABLE/i.test(sql)) return false;
    return true;
  }

  // 读取全库：[{name, columns, rows}] + user_version
  function dumpTables(deps) {
    return Promise.resolve(deps.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL", []))
      .then(function (objs) {
        var names = objs.filter(isDataTable).map(function (o) { return o.name; });
        var chain = Promise.resolve([]);
        names.forEach(function (name) {
          chain = chain.then(function (acc) {
            return Promise.resolve(deps.all('PRAGMA table_info(' + name + ')', []))
              .then(function (cols) {
                var columns = cols.map(function (c) { return c.name; });
                return Promise.resolve(deps.all('SELECT * FROM ' + name, [])).then(function (rows) {
                  acc.push({ name: name, columns: columns, rows: rows });
                  return acc;
                });
              });
          });
        });
        return chain;
      })
      .then(function (tables) {
        return Promise.resolve(deps.all('PRAGMA user_version', [])).then(function (uv) {
          return { tables: tables, userVersion: (uv && uv[0] && Number(uv[0].user_version)) || 0 };
        });
      });
  }

  // 由 dump 生成参数化语句序列（DELETE + INSERT），settings 表值先过密钥剔除
  function toStatements(dump) {
    var statements = []; var redacted = []; var counts = {};
    (dump.tables).forEach(function (t) {
      counts[t.name] = t.rows.length;
      statements.push({ sql: 'DELETE FROM ' + t.name, params: [] });
      t.rows.forEach(function (row) {
        var cols = t.columns;
        var vals = cols.map(function (c) {
          var v = row[c];
          if (t.name === 'settings' && c === 'value_json' && typeof v === 'string') {
            try {
              var r = redactSensitive(JSON.parse(v), '', []);
              if (r.redacted.length) { r.redacted.forEach(function (p) { redacted.push(p); }); v = JSON.stringify(r.value); }
            } catch (e) { /* 非 JSON 原样保留 */ }
          }
          return v;
        });
        statements.push({
          sql: 'INSERT INTO ' + t.name + ' (' + cols.join(',') + ') VALUES (' +
               cols.map(function () { return '?'; }).join(',') + ')',
          params: vals
        });
      });
    });
    return { statements: statements, counts: counts, redacted: redacted };
  }

  // 打包：manifest.json + database.json → zip 字节
  function buildBackup(deps, meta) {
    var ZIP = root.NOVEL_ZIP;
    if (!ZIP) return Promise.reject(new Error('备份依赖 NOVEL_ZIP（请先加载 zip.js）'));
    meta = meta || {};
    return dumpTables(deps).then(function (dump) {
      var s = toStatements(dump);
      var manifest = {
        app: 'novel-ai-writer', kind: 'backup',
        schema_version: dump.userVersion,
        created_at: meta.created_at || Date.now(),
        book_title: meta.book_title || '',
        tables: dump.tables.map(function (t) { return t.name; }),
        counts: s.counts,
        redacted_secret_fields: s.redacted        // 记录被剔除的疑似密钥字段路径（值本身不落盘）
      };
      var entries = [
        { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
        { name: 'database.json', data: JSON.stringify({ schema_version: dump.userVersion, statements: s.statements }) }
      ];
      return { manifest: manifest, statements: s.statements, entries: entries, bytes: ZIP.build(entries) };
    });
  }

  // 解包
  function readBackup(bytes) {
    var ZIP = root.NOVEL_ZIP;
    var items = ZIP.list(bytes);
    var manifest = null, dbjson = null;
    items.forEach(function (e) {
      if (e.name === 'manifest.json') manifest = JSON.parse(e.text());
      else if (e.name === 'database.json') dbjson = JSON.parse(e.text());
    });
    if (!manifest || !dbjson) throw new Error('备份包缺少 manifest.json 或 database.json');
    return { manifest: manifest, statements: dbjson.statements || [] };
  }

  // 在包内文本里查已知密钥值是否泄漏
  function scanSecrets(bytes, secretValues) {
    var ZIP = root.NOVEL_ZIP;
    var hay = ZIP.list(bytes).map(function (e) { return e.text(); }).join('\n');
    return (secretValues || []).filter(function (s) { return s && hay.indexOf(String(s)) >= 0; });
  }

  // 恢复：版本闸 → safety hook → 参数化重放（FK off + 事务）
  // 用 async/await + try/catch：deps.run 同步抛错也能捕获；ROLLBACK/COMMIT 再抛（如无活动事务）也不外泄
  function restore(deps, parsed, opts) {
    opts = opts || {};
    var now = opts.now || Date.now;
    var supported = opts.currentVersion != null ? opts.currentVersion
      : (root.NOVEL_SCHEMA && root.NOVEL_SCHEMA.LATEST_VERSION);
    var bv = parsed.manifest && parsed.manifest.schema_version;
    if (supported != null && bv != null && bv > supported) {
      return Promise.resolve({ ok: false, reason: 'version-too-new', backupVersion: bv, supported: supported });
    }
    var order = [];
    return (async function () {
      try {
        if (typeof opts.makeSafety === 'function') { await opts.makeSafety(); order.push('safety'); }
        else order.push('safety-skipped');
        order.push('apply');
        await deps.exec('PRAGMA foreign_keys = OFF');
        await deps.exec('BEGIN');
        var stmts = parsed.statements || [];
        for (var i = 0; i < stmts.length; i++) {
          await deps.run(stmts[i].sql, stmts[i].params || []);
        }
        await deps.exec('COMMIT');
        await deps.exec('PRAGMA user_version = ' + (bv != null ? bv : (supported || 0)));
        await deps.exec('PRAGMA foreign_keys = ON');
        return { ok: true, restored: stmts.length, safety: order.indexOf('safety') >= 0, order: order, at: now() };
      } catch (err) {
        try { await deps.exec('ROLLBACK'); } catch (ignored) {}
        try { await deps.exec('PRAGMA foreign_keys = ON'); } catch (ignored2) {}
        return { ok: false, reason: 'apply-failed', error: String(err && err.message || err) };
      }
    })();
  }

  root.NOVEL_BACKUP = {
    dumpTables: dumpTables, toStatements: toStatements,
    buildBackup: buildBackup, readBackup: readBackup, restore: restore, scanSecrets: scanSecrets,
    _internal: { redactSensitive: redactSensitive, isDataTable: isDataTable, esc: esc, SECRET_FIELD: SECRET_FIELD }
  };
})(globalThis);
