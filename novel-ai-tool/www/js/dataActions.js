/* 数据操作胶水（M6 UI 背后的编排层）：把 exporter/docx/zipper/importer/backup/storage 这些
   已各自跑绿的逻辑件，组合成"导出/导入/备份/恢复/存储统计"五个可直接被 views.js 调用的动作。
   与 db.js 同构——不持有连接、不碰 DOM，全靠注入 deps：
     deps.db      = NOVEL_DB            取书/章/角色（高层 API）
     deps.adapter = { all,run,exec }    裸 SQLite 适配器（backup/storage 用；App 端 = root.NOVEL_ADAPTER）
     deps.temp    = NOVEL_TEMP          文本与二进制产物落 temp/（zip/docx/备份靠 writeBytes/readBytes）
     deps.secure  = NOVEL_SECURE        可选，恢复前 safety 快照不需要它
   产物一律只落 temp/ 受控分类，绝不散落外部存储；分享/写 Downloads 交原生层（另议）。
   纯电脑侧可用内存 sink + node:sqlite 逐数断言（见 tests/m6_actions.test.cjs）。 */
(function (root) {
  'use strict';

  function mod(name) { return root[name]; }

  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function stamp(ts) {
    var d = new Date(ts);
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  // 读一本书的完整导出素材：book + 带正文的 chapters + characters + 全书字数
  function readBundle(deps, bookId) {
    var DBp = deps.db;
    return DBp.listBooks().then(function (bs) {
      var book = null;
      for (var i = 0; i < bs.length; i++) if (String(bs[i].id) === String(bookId)) { book = bs[i]; break; }
      if (!book) throw new Error('作品不存在: ' + bookId);
      return DBp.listChapters(bookId).then(function (metas) {
        return Promise.all(metas.map(function (m) { return DBp.getChapter(m.id); }));
      }).then(function (chs) {
        var chapters = chs.filter(Boolean);
        var totalWords = chapters.reduce(function (a, c) { return a + (c.word_count || 0); }, 0);
        return DBp.listCharacters(bookId).then(function (chars) {
          return { book: book, chapters: chapters, characters: chars || [], totalWords: totalWords };
        });
      });
    });
  }

  // 导出：format = 'txt' | 'docx' | 'zip'；txt 可选 splitChapters 另出分章文件
  function exportBook(deps, opts) {
    opts = opts || {};
    var format = opts.format || 'txt';
    var EXP = mod('NOVEL_EXPORTER'), ZIPPER = mod('NOVEL_ZIPPER'), DOCX = mod('NOVEL_DOCX');
    var temp = deps.temp;
    if (!EXP || !temp) return Promise.reject(new Error('导出需要 NOVEL_EXPORTER 与 NOVEL_TEMP'));
    return readBundle(deps, opts.bookId).then(function (b) {
      var base = EXP.safeFile(b.book.title || 'novel');
      var files = [];
      if (format === 'txt') {
        var text = EXP.fullText(b.book, b.chapters, { includeNumber: !!opts.includeNumber, includeFrontmatter: true });
        var name = base + '.txt';
        return EXP.writeTxt(name, text, temp).then(function (p) {
          files.push({ name: name, rel: p, bytes: text.length });
          if (!opts.splitChapters) return { format: format, base: base, files: files, bundle: summarize(b) };
          var jobs = EXP.chapterFiles(b.chapters, { includeNumber: !!opts.includeNumber })
            .map(function (f) { return EXP.writeTxt(base + '/分章/' + f.name, f.text, temp).then(function (p2) { files.push({ name: f.name, rel: p2 }); }); });
          return Promise.all(jobs).then(function () { return { format: format, base: base, files: files, bundle: summarize(b) }; });
        });
      }
      if (format === 'docx') {
        if (!DOCX) throw new Error('docx 需要 NOVEL_DOCX');
        var d = DOCX.build(b.book, b.chapters, { totalWords: b.totalWords });
        var dname = base + '.docx';
        return temp.writeBytes('export', dname, d.bytes).then(function (p) {
          return { format: format, base: base, files: [{ name: dname, rel: p, bytes: d.bytes.length }], bundle: summarize(b) };
        });
      }
      if (format === 'zip') {
        if (!ZIPPER) throw new Error('作品包需要 NOVEL_ZIPPER');
        var z = ZIPPER.buildNovelZip(b.book, b.chapters, b.characters);
        var zname = z.base + '.zip';
        return ZIPPER.writePackage(z.bytes, zname, temp).then(function (p) {
          return { format: format, base: z.base, files: [{ name: zname, rel: p, bytes: z.bytes.length }], bundle: summarize(b) };
        });
      }
      throw new Error('未知导出格式: ' + format);
    });
  }

  function summarize(b) {
    return { title: b.book.title, chapters: b.chapters.length, words: b.totalWords, characters: b.characters.length };
  }

  // 导入：把一段纯文本按章切分后建书 + 逐章落正文（reason='import'，首章覆盖空正文不快照）
  function importBook(deps, opts) {
    opts = opts || {};
    var IMP = mod('NOVEL_IMPORTER'), DBp = deps.db;
    if (!IMP) return Promise.reject(new Error('导入需要 NOVEL_IMPORTER'));
    var text = String(opts.text == null ? '' : opts.text);
    if (!text.trim()) return Promise.reject(new Error('导入内容为空'));
    var parts = IMP.looksChaptered(text) ? IMP.split(text) : IMP.blankSplit(text);
    if (!parts.length) parts = [{ title: '', body: text.trim() }];
    var title = (opts.title && String(opts.title).trim()) || '导入作品';
    return DBp.createBook({ title: title, synopsis: opts.synopsis || '' }).then(function (bookId) {
      var chain = Promise.resolve(0);
      parts.forEach(function (pt, i) {
        chain = chain.then(function (n) {
          return DBp.createChapter(bookId, pt.title || '第' + (i + 1) + '章').then(function (cid) {
            return DBp.saveChapterBody(cid, pt.body || '', 'import').then(function () { return n + 1; });
          });
        });
      });
      return chain.then(function (n) { return { bookId: bookId, chapters: n, title: title }; });
    });
  }

  // 立即备份：整库 → zip（manifest+database），落 temp/backup；密钥剔除由 backup.js 保证
  function backupNow(deps, meta) {
    meta = meta || {};
    var BK = mod('NOVEL_BACKUP');
    if (!BK) return Promise.reject(new Error('备份需要 NOVEL_BACKUP'));
    if (!deps.adapter) return Promise.reject(new Error('备份需要裸适配器 deps.adapter'));
    var created = meta.created_at || Date.now();
    return BK.buildBackup(deps.adapter, { created_at: created, book_title: meta.book_title || '' }).then(function (res) {
      var name = (meta.prefix || 'backup') + '_' + stamp(created) + '.zip';
      return deps.temp.writeBytes('backup', name, res.bytes).then(function (p) {
        return { name: name, rel: p, bytes: res.bytes.length, manifest: res.manifest, redacted: res.manifest.redacted_secret_fields };
      });
    });
  }

  // 从备份恢复：默认先自动快照当前库（safety-before-restore，落 temp/backup），再版本闸+参数化重放
  function restoreFrom(deps, opts) {
    opts = opts || {};
    var BK = mod('NOVEL_BACKUP');
    if (!BK) return Promise.reject(new Error('恢复需要 NOVEL_BACKUP'));
    var getBytes = opts.bytes != null ? Promise.resolve(opts.bytes)
      : (opts.name != null ? deps.temp.readBytes('backup', opts.name) : Promise.reject(new Error('恢复需指定 opts.name 或 opts.bytes')));
    return getBytes.then(function (bytes) {
      var parsed = BK.readBackup(bytes);
      var makeSafety = opts.makeSafety;
      if (makeSafety === undefined) {
        makeSafety = function () { return backupNow(deps, { book_title: 'safety-before-restore', prefix: 'safety' }).then(function () {}); };
      }
      return BK.restore(deps.adapter, parsed, { makeSafety: makeSafety || undefined, currentVersion: opts.currentVersion });
    });
  }

  // 列出 temp/backup 里的备份包（供"恢复最近备份"选择），按名字里时间戳倒序
  function listBackups(deps) {
    if (!deps.temp || typeof deps.temp.list !== 'function') return Promise.resolve([]);
    return Promise.resolve(deps.temp.list('backup')).then(function (items) {
      return (items || []).filter(function (f) { return /\.zip$/i.test(f.name); })
        .sort(function (a, b) { return a.name < b.name ? 1 : -1; });
    }, function () { return []; });
  }

  // 存储统计：委托 storage.js（各表行数/总字数/AI 用量/库体积/temp 占用/可选某书明细）
  function storageReport(deps, opts) {
    var ST = mod('NOVEL_STORAGE');
    if (!ST) return Promise.reject(new Error('统计需要 NOVEL_STORAGE'));
    return ST.collect({ db: deps.adapter, temp: deps.temp }, opts || {});
  }

  root.NOVEL_DATA_ACTIONS = {
    readBundle: readBundle, exportBook: exportBook, importBook: importBook,
    backupNow: backupNow, restoreFrom: restoreFrom, listBackups: listBackups, storageReport: storageReport,
    _internal: { stamp: stamp, summarize: summarize }
  };
})(globalThis);
