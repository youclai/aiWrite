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

  /* ---------- 文档识别读取（优化批次 A）：按字节魔数分流 txt / docx / 拒绝旧 .doc ----------
     识别与降级集中在此，UI 只看 kind：{kind:'text'|'docx', text} 或 {kind:'reject', error}。
     docx 只负责“变成纯文本”，切分/落库完全复用现有 importBook 路径（导入逻辑不变）。 */
  function readDocument(u8) {
    var b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8 || []);
    function byteAt(i) { return b.length > i ? b[i] : -1; }
    // PK\x03\x04 → ZIP 容器：当 docx 读（取 word/document.xml 正文）
    if (byteAt(0) === 0x50 && byteAt(1) === 0x4B && byteAt(2) === 0x03 && byteAt(3) === 0x04) {
      var DOCX = mod('NOVEL_DOCX');
      if (!DOCX || !DOCX.extractText) return Promise.reject(new Error('docx 读取器未加载（需 docx.js/zip.js）'));
      return DOCX.extractText(b).then(function (text) { return { kind: 'docx', text: text }; });
    }
    // D0 CF 11 E0 → OLE 复合文档（旧式 .doc）：明确拒绝，不猜内容
    if (byteAt(0) === 0xD0 && byteAt(1) === 0xCF && byteAt(2) === 0x11 && byteAt(3) === 0xE0) {
      return Promise.resolve({ kind: 'reject', error: '旧版 .doc 格式不支持：请在电脑上另存为 .docx 或 .txt 后再导入' });
    }
    // 其余按纯文本：UTF-8 优先、乱码回退 GB18030（复用 SI.decodeTxt）
    var SI = mod('NOVEL_STRUCTURED_IMPORT');
    var dec = (SI && SI.decodeTxt) ? SI.decodeTxt(b) : { text: new TextDecoder('utf-8', { fatal: false }).decode(b), encoding: 'UTF-8' };
    return Promise.resolve({ kind: 'text', text: dec.text, encoding: dec.encoding });
  }

  /* ---------- 导入取消回滚基建（优化批次 G） ----------
     opts.onProgress(done, total, secDone, currentTitle)  逐章（sectionOnly 逐节）回调一次，给 UI 进度条
     opts.cancelRef = {cancelled:false}                   协作式取消：只在章/节边界检查，不打断单条 SQL
     取消后默认硬删本次已写入内容（new 连书一起删；merge/sectionOnly 逐条删本次 createdIds），
     绝不碰用户既有数据；非取消的失败不自动删，保留“已成功 k/n + 重试”口径。 */
  function cancelError() { var e = new Error('已取消导入'); e.cancelled = true; return e; }
  function rollbackIds(list, delFn) {
    var removed = 0, failed = 0;
    return list.reduce(function (p, id) {
      return p.then(function () {
        return Promise.resolve(delFn(id)).then(function () { removed++; }, function () { failed++; });
      });
    }, Promise.resolve()).then(function () { return { removed: removed, failed: failed }; });
  }
  // 取消时执行回滚并把结果挂到错误对象；回滚链自身异常不阻断“已取消”回传
  function cancelWithRollback(err, list, delFn, unitLabel) {
    return rollbackIds(list, delFn).then(function (rb) {
      err.removed = rb.removed; err.rollbackFailed = rb.failed; err.rollbackUnit = unitLabel;
      throw err;
    }, function (e2) { err.rollbackFailed = (err.rollbackFailed || 0) + list.length; throw err; });
  }

  // 单节录入（sectionOnly）：只按「第X节/点号」切节，全部追加进指定目标章的 sections 之下；
  // 不建书不建章、章正文一字不碰；idx 由 createSection 取 MAX+1 自然接在既有节之后（§3.0/§4-B）。
  function importSectionsOnly(deps, opts, text) {
    var SI = mod('NOVEL_STRUCTURED_IMPORT'), DBp = deps.db;
    if (!SI) return Promise.reject(new Error('外部导入需要 NOVEL_STRUCTURED_IMPORT'));
    if (opts.chapterId == null || String(opts.chapterId) === '') return Promise.reject(new Error('单节录入需要选择目标章节'));
    var cid = Number(opts.chapterId);
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var cancelRef = opts.cancelRef || null;
    return DBp.getChapter(cid).then(function (ch) {
      if (!ch) throw new Error('目标章节不存在（id=' + cid + '），请重新选择');
      var parsed = SI.parseSections(text);
      if (!parsed.sections.length)
        return Promise.reject(new Error('未识别到任何“第X节”标题，无法按单节录入；可改用其它录入格式'));
      var done = 0, total = parsed.sections.length, chain = Promise.resolve(0);
      var createdSectionIds = [];   // 本次已建节 id（G 回滚清单）
      parsed.sections.forEach(function (s) {
        chain = chain.then(function () {
          if (cancelRef && cancelRef.cancelled) throw cancelError();   // 节边界生效，无半条写入风险
          return DBp.createSection(cid, s.title || '').then(function (sid) {
            createdSectionIds.push(sid);
            return DBp.saveSectionBody(sid, s.body || '').then(function () {
              done++;
              if (onProgress) { try { onProgress(done, total, 0, s.title || ''); } catch (e) { /* UI 回调不阻断导入 */ } }
            });
          });
        });
      });
      return chain.then(function () {
        return { bookId: ch.book_id, chapterId: cid, mode: 'section', format: 'sectionOnly', chapters: 0, sections: done, title: ch.title || '' };
      }, function (e) {
        var err = e instanceof Error ? e : new Error((e && e.message) || String(e || '导入失败'));
        err.imported = done; err.total = total; err.sections = done;
        if (err.cancelled) return cancelWithRollback(err, createdSectionIds, DBp.deleteSection, '节');
        throw err;
      });
    });
  }

  // 导入：把一段纯文本落库。四种格式 × 两种模式（建议 6 + 外部导入规划书 v2）：
  //   format='auto'：沿用 NOVEL_IMPORTER（looksChaptered ? split : blankSplit），只建章不建节；
  //   format='split'（章节分开录入，旧名 'structured' 仍作别名兼容）：「章 > 节」两层树，节写 sections 挂所属章；
  //     一个章/节标题都没有 → reject 并提示改用自动切分（不猜结构）。
  //   format='chapterOnly'（单章录入）：只按章切、节行降级为正文并入章 body，不建节；无章标题则整篇一章。
  //   format='sectionOnly'（单节录入）：只按节切，**并入指定目标章**（opts.chapterId），不建章、不动章正文。
  //   mode='new'（默认）建书（书名/作者/简介优先级：界面 > 封面头解析 > 默认）；
  //   mode='merge' 不建书，向目标书末尾按序追加，绝不改动既有章正文；重名只追加不合并。
  // 逐章串行写入（无批量事务）；中途失败 reject 带 imported/total/sections 供 UI 报“已成功 k/n 章 + 重试”。
  function importBook(deps, opts) {
    opts = opts || {};
    var mode = opts.mode === 'merge' ? 'merge' : 'new';
    var format = String(opts.format || 'auto');
    if (format === 'structured') format = 'split';   // v1 旧名别名（旧调用/真机探针兼容）
    if (['auto', 'split', 'chapterOnly', 'sectionOnly'].indexOf(format) < 0) format = 'auto';
    var IMP = mod('NOVEL_IMPORTER'), DBp = deps.db;
    if (!IMP) return Promise.reject(new Error('导入需要 NOVEL_IMPORTER'));
    var text = String(opts.text == null ? '' : opts.text);
    if (!text.trim()) return Promise.reject(new Error('导入内容为空'));
    if (format === 'sectionOnly') return importSectionsOnly(deps, opts, text);
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var cancelRef = opts.cancelRef || null;

    // 非 auto 格式统一成 units：[{title, body, sections:[{title, body}]}]，落库链路共用
    var units = [], parsed = null;
    if (format === 'split' || format === 'chapterOnly') {
      var SI = mod('NOVEL_STRUCTURED_IMPORT');
      if (!SI) return Promise.reject(new Error('外部导入需要 NOVEL_STRUCTURED_IMPORT'));
      parsed = format === 'chapterOnly' ? SI.parseChapters(text) : SI.parse(text);
      if (!parsed.chapters.length) {
        if (format === 'chapterOnly') {
          units = [{ title: '', body: text.trim(), sections: [] }];   // 无章标题→整篇一章（§3.2）
        } else {
          return Promise.reject(new Error('未识别到任何“第X章/第X节”标题；如只想按空行分块，请改用“按章节标题自动切分”'));
        }
      } else {
        units = parsed.chapters.map(function (c) {
          return { title: c.title, body: c.body, sections: (c.sections || []).map(function (s) { return { title: s.title, body: s.body }; }) };
        });
      }
    } else {
      var parts = IMP.looksChaptered(text) ? IMP.split(text) : IMP.blankSplit(text);
      if (!parts.length) parts = [{ title: '', body: text.trim() }];
      units = parts.map(function (p) { return { title: p.title, body: p.body, sections: [] }; });
    }

    // 逐章链式写入 bookId 目标书；每章下再串行写其节；done/secDone 记录进度，失败挂到错误对象供可读重试；
    // G：章边界检查 cancelRef；边写边记 createdChapterIds 供取消回滚；每完成一章回调 onProgress
    function writeChains(bookId, baseIdx, createdChapterIds) {
      var done = 0, total = units.length, secDone = 0;
      var chain = Promise.resolve(0);
      units.forEach(function (u, i) {
        chain = chain.then(function () {
          if (cancelRef && cancelRef.cancelled) throw cancelError();   // 只在章边界生效，不在单条 SQL 里硬切
          var chTitle = u.title || '第' + (baseIdx + i + 1) + '章';
          return DBp.createChapter(bookId, chTitle).then(function (cid) {
            createdChapterIds.push(cid);
            return DBp.saveChapterBody(cid, u.body || '', 'import').then(function () {
              done++;
              // 每章完成回调一次（无节章进度不能停在上一有节章，取消也靠它及时生效）
              if (onProgress) { try { onProgress(done, total, secDone, chTitle); } catch (e) { /* UI 回调不阻断导入 */ } }
              var schain = Promise.resolve(0);
              (u.sections || []).forEach(function (s) {
                schain = schain.then(function () {
                  return DBp.createSection(cid, s.title || '').then(function (sid) {
                    return DBp.saveSectionBody(sid, s.body || '').then(function () {
                      secDone++;
                      if (onProgress) { try { onProgress(done, total, secDone, chTitle); } catch (e) {} }
                    });
                  });
                });
              });
              return schain;
            });
          });
        });
      });
      return chain.then(function () {
        return { chapters: done, sections: secDone };
      }, function (e) {
        // 非 Error 拒绝值（字符串等）归一后再挂进度，严格模式下不可直接给原始值加属性
        var err = e instanceof Error ? e : new Error((e && e.message) || String(e || '导入失败'));
        err.imported = done; err.total = total; err.sections = secDone;
        throw err;
      });
    }
    // 取消→回滚入口：merge 逐条删本次新建章（级联其节），既有章零触碰
    function cancelRollbackChapters(err, createdChapterIds) {
      if (err.cancelled) return cancelWithRollback(err, createdChapterIds, DBp.deleteChapter, '章');
      return Promise.reject(err);
    }

    if (mode === 'merge') {
      if (opts.bookId == null || String(opts.bookId) === '') return Promise.reject(new Error('并入模式需要选择目标书籍'));
      return DBp.listBooks().then(function (bs) {
        var book = null;
        for (var i = 0; i < bs.length; i++) if (String(bs[i].id) === String(opts.bookId)) { book = bs[i]; break; }
        if (!book) return Promise.reject(new Error('目标书籍不存在（id=' + opts.bookId + '），请重新选择'));
        return DBp.listChapters(book.id).then(function (existing) {
          var createdChapterIds = [];
          return writeChains(book.id, existing.length, createdChapterIds).then(function (n) {
            return { bookId: book.id, mode: 'merge', format: format, appended: n.chapters, chapters: n.chapters, sections: n.sections, title: book.title };
          }, function (e) {
            return cancelRollbackChapters(e, createdChapterIds);
          });
        });
      });
    }

    // 新建：书名优先级 界面填写 > 封面头解析 > '导入作品'（§3.5）；作者/简介取封面头
    var meta = parsed ? parsed.bookMeta : {};
    var title = (opts.title && String(opts.title).trim()) || meta.title || '导入作品';
    var author = (opts.author && String(opts.author).trim()) || meta.author || '';
    var synopsis = (opts.synopsis && String(opts.synopsis).trim()) || meta.synopsis || '';
    return DBp.createBook({ title: title, author: author, synopsis: synopsis }).then(function (bookId) {
      var createdChapterIds = [];
      return writeChains(bookId, 0, createdChapterIds).then(function (n) {
        return { bookId: bookId, mode: 'new', format: format, chapters: n.chapters, sections: n.sections, title: title };
      }, function (e) {
        // new 模式取消：book 是本次新盖的，deleteBook 一步还原（FK CASCADE 连带删掉本次建的章与节）
        if (e.cancelled) {
          return cancelWithRollback(e, [bookId], DBp.deleteBook, '章').catch(function (err2) {
            err2.removedChapters = createdChapterIds.length;
            throw err2;
          });
        }
        throw e;
      });
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
    readBundle: readBundle, exportBook: exportBook, importBook: importBook, readDocument: readDocument,
    backupNow: backupNow, restoreFrom: restoreFrom, listBackups: listBackups, storageReport: storageReport,
    _internal: { stamp: stamp, summarize: summarize, rollbackIds: rollbackIds }
  };
})(globalThis);
