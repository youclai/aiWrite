/* 二次产物暂存层：所有"由用户原始稿件再生产出来"的文件一律只落在应用私有目录下的单一 temp/ 根，
   并在其内按分类子目录归档（用户的小说导出、人物标签、AI 中间结果、备份、日志……）。
   目的：主数据（SQLite 库）与派生数据物理隔离，temp/ 可整体清空/统计/迁移，绝不散落外部存储。

   与 db.js / secureStore.js 同构——适配器注入：
   - App 端适配器走 @capacitor/filesystem（Directory.Data，路径前缀 temp/，免存储权限）
   - Node 测试端适配器走真实 fs（临时目录当根）
   本模块只做"路径归一 + 越界防护 + 分类映射 + 读写列举"，具体 IO 全权交给适配器。 */
(function (root) {
  'use strict';

  var fsa = null;             // 文件适配器
  var ready = false;
  var lastError = '';

  var ROOT = 'temp';          // 唯一根目录名，所有派生数据都关在这里

  // 分类枚举 → temp/ 下子目录名。新增派生产物先在此登记，避免随手建目录。
  var CATEGORIES = {
    novels: 'novels',        // 用户小说的导出/分章 txt、作品 zip
    characters: 'characters',// 人物卡/人物标签的导出与中间态
    ai: 'ai',                // AI 流式中间结果、预览缓存、dry_run 快照
    export: 'export',        // 导出的 txt / docx / zip 成品（分享前的暂存）
    backup: 'backup',        // 自动备份、恢复前的 safety_<ts>.db
    import: 'import',        // 从外部/txt 导入时的暂存与分块中间件
    logs: 'logs',            // 崩溃与请求失败日志（落盘前先经 NOVEL_SECURE.redact）
    preview: 'preview'       // 其它一次性预览产物
  };
  var CAT_LIST = Object.keys(CATEGORIES);

  function requireReady() {
    if (!ready) throw new Error('暂存层未就绪：' + (lastError || '请先调用 NOVEL_TEMP.init()'));
  }

  function normCat(cat) {
    if (!Object.prototype.hasOwnProperty.call(CATEGORIES, cat)) {
      throw new Error('未知暂存分类: ' + cat + '（允许：' + CAT_LIST.join('/') + '）');
    }
    return CATEGORIES[cat];
  }

  // 只允许裸文件名或"子路径/文件"，但绝不允许越出 temp/ 根：拒绝绝对路径、盘符、.. 回溯
  function safeName(name) {
    if (typeof name !== 'string' || !name.length) throw new Error('文件名非法: ' + name);
    if (/^[\\/]/.test(name)) throw new Error('文件名不能以分隔符开头（应为相对名）: ' + name);
    if (/^[a-zA-Z]:/.test(name)) throw new Error('文件名不能含盘符: ' + name);
    if (name.indexOf('\0') >= 0) throw new Error('文件名含非法字符');
    var parts = name.split(/[\\/]+/);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '.' || parts[i] === '..') throw new Error('路径越界（含 . 或 ..）: ' + name);
      if (parts[i].indexOf(':') >= 0) throw new Error('路径越界（含冒号）: ' + name);
    }
    return parts.join('/');
  }

  // 归类相对路径 = temp/<分类>/<名字>；统一用正斜杠，交给适配器决定是否转换
  function relPath(cat, name) { return ROOT + '/' + normCat(cat) + '/' + safeName(name); }
  function relDir(cat) { return ROOT + '/' + normCat(cat); }

  // adapter 需提供（均可返回 Promise）：
  //   writeFile(relPath, content)      content 为 utf8 字符串
  //   readFile(relPath) -> string
  //   exists(relPath) -> boolean
  //   readdir(relDir) -> [{ name, isDir }]
  //   deleteFile(relPath)
  //   removeDir(relDir, recursive)
  //   stat(relPath) -> { size }
  //   ensureDir(relDir)      可选；无则由 write 时 recursive 兜底
  function init(adapter) {
    ready = false; lastError = '';
    if (!adapter || typeof adapter.writeFile !== 'function' || typeof adapter.readFile !== 'function') {
      lastError = 'init 需要带 writeFile/readFile 的文件适配器';
      return Promise.reject(new Error(lastError));
    }
    var need = ['exists', 'readdir', 'deleteFile', 'stat'];
    for (var i = 0; i < need.length; i++) {
      if (typeof adapter[need[i]] !== 'function') { lastError = '适配器缺少方法: ' + need[i]; return Promise.reject(new Error(lastError)); }
    }
    fsa = adapter;
    ready = true;
    // 建好各分类目录（尽力而为，失败不阻断——写入时适配器会再兜底）
    var jobs = CAT_LIST.map(function (c) {
      if (!fsa.ensureDir) return Promise.resolve();
      return Promise.resolve(fsa.ensureDir(relDir(c))).catch(function () {});
    });
    return Promise.all(jobs).then(function () { return { ready: true, root: ROOT }; },
      function () { return { ready: true, root: ROOT }; });
  }

  function isReady() { return ready; }
  function state() { return { ready: ready, error: lastError, root: ROOT, categories: CAT_LIST }; }

  function write(cat, name, content) {
    requireReady();
    var p = relPath(cat, name);
    var pre = fsa.ensureDir ? fsa.ensureDir(relDir(cat)) : Promise.resolve();
    return Promise.resolve(pre).catch(function () {}).then(function () {
      return fsa.writeFile(p, content == null ? '' : String(content));
    }).then(function () { return p; });
  }

  function read(cat, name) {
    requireReady();
    return Promise.resolve(fsa.readFile(relPath(cat, name)));
  }

  // 二进制落盘：zip/docx/备份包等 Uint8Array 产物专用（writeFile 只吃 utf8 字符串，会损坏字节）。
  // 适配器须提供 writeBytes(relPath, Uint8Array)；Node 测试端用 fs.writeFileSync(Buffer)，App 端用 Filesystem base64。
  function writeBytes(cat, name, bytes) {
    requireReady();
    if (typeof fsa.writeBytes !== 'function') return Promise.reject(new Error('暂存适配器不支持二进制写入（缺 writeBytes）'));
    if (!(bytes instanceof Uint8Array)) return Promise.reject(new Error('writeBytes 需要 Uint8Array'));
    var p = relPath(cat, name);
    var pre = fsa.ensureDir ? fsa.ensureDir(relDir(cat)) : Promise.resolve();
    return Promise.resolve(pre).catch(function () {}).then(function () {
      return fsa.writeBytes(p, bytes);
    }).then(function () { return p; });
  }

  // 二进制读回：恢复备份 / 重新分享已存产物时用；适配器须有 readBytes(relPath)->Uint8Array
  function readBytes(cat, name) {
    requireReady();
    if (typeof fsa.readBytes !== 'function') return Promise.reject(new Error('暂存适配器不支持二进制读取（缺 readBytes）'));
    return Promise.resolve(fsa.readBytes(relPath(cat, name)));
  }

  function exists(cat, name) {
    requireReady();
    return Promise.resolve(fsa.exists(relPath(cat, name)));
  }

  function remove(cat, name) {
    requireReady();
    return Promise.resolve(fsa.deleteFile(relPath(cat, name))).then(function () { return true; });
  }

  // 列出某分类下的文件（不含子目录内容），返回 { name, path, isDir }
  function list(cat) {
    requireReady();
    var dir = relDir(cat);
    return Promise.resolve(fsa.readdir(dir)).then(function (items) {
      return (items || []).filter(function (it) { return !it.isDir; }).map(function (it) {
        return { name: it.name, path: dir + '/' + it.name, isDir: false };
      });
    }, function () { return []; });   // 目录不存在视作空
  }

  // 清空某分类（递归删除后重建）
  function clearCategory(cat) {
    requireReady();
    var dir = relDir(cat);
    var p = fsa.removeDir ? Promise.resolve(fsa.removeDir(dir, true)) : Promise.resolve();
    return p.catch(function () {}).then(function () {
      return fsa.ensureDir ? fsa.ensureDir(dir) : undefined;
    }).then(function () { return true; });
  }

  // 清空整个 temp/ 根（保留根目录本身，删掉所有分类树）
  function clearAll() {
    requireReady();
    var p = fsa.removeDir ? Promise.resolve(fsa.removeDir(ROOT, true)) : Promise.resolve();
    return p.catch(function () {}).then(function () {
      return Promise.all(CAT_LIST.map(function (c) {
        return fsa.ensureDir ? fsa.ensureDir(relDir(c)) : undefined;
      }));
    }).then(function () { return true; }, function () { return true; });
  }

  // 存储统计：各分类文件数与字节数 + 总量。F47 用得上；只统计 temp/ 内的派生产物。
  function usage() {
    requireReady();
    var total = { files: 0, bytes: 0 };
    var byCat = {};
    var chain = Promise.resolve();
    CAT_LIST.forEach(function (c) {
      chain = chain.then(function () {
        return list(c).then(function (files) {
          var sizeChain = Promise.resolve(0);
          files.forEach(function (f) {
            sizeChain = sizeChain.then(function (acc) {
              return Promise.resolve(fsa.stat(f.path)).then(function (st) {
                return acc + (st && st.size ? Number(st.size) : 0);
              }, function () { return acc; });
            });
          });
          return sizeChain.then(function (bytes) {
            byCat[c] = { files: files.length, bytes: bytes };
            total.files += files.length; total.bytes += bytes;
          });
        });
      });
    });
    return chain.then(function () {
      return { root: ROOT, byCategory: byCat, total: total };
    });
  }

  root.NOVEL_TEMP = {
    ROOT: ROOT,
    CATEGORIES: CATEGORIES,
    CATEGORY_LIST: CAT_LIST,
    init: init, isReady: isReady, state: state,
    relPath: relPath, relDir: relDir,          // 暴露给"写 Downloads/分享"时反查相对路径
    write: write, read: read, exists: exists, remove: remove, list: list,
    writeBytes: writeBytes, readBytes: readBytes,
    clearCategory: clearCategory, clearAll: clearAll, usage: usage,
    _internal: { safeName: safeName, normCat: normCat }
  };
})(globalThis);
