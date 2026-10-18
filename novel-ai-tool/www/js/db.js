/* 数据访问层：适配器注入，App 用 Capacitor SQLite，Node 测试用 node:sqlite */
(function (root) {
  'use strict';

  var S = root.NOVEL_SCHEMA;

  var db = null;              // 适配器：{ all, run, exec }
  var info = { fromVersion: 0, toVersion: 0, ftsMode: 'like' };

  function now() { return Date.now(); }

  // 字数 = 非空白字符数（Array.from 保证中文与 emoji 计数正确）
  function countWords(text) {
    var out = 0;
    Array.from(String(text || '')).forEach(function (ch) { if (!/\s/.test(ch)) out++; });
    return out;
  }

  function all(sql, params) { return Promise.resolve(db.all(sql, norm(params))); }
  function run(sql, params) { return Promise.resolve(db.run(sql, norm(params))); }
  function exec(sql) { return Promise.resolve(db.exec(sql)); }

  // 未传的字段当 NULL 处理，避免真机适配器对 undefined 抛错
  function norm(params) {
    return (params || []).map(function (p) { return p === undefined ? null : p; });
  }

  /* ---------- 迁移 ---------- */

  function currentVersion() {
    return all('PRAGMA user_version', []).then(function (r) {
      return (r && r[0] && Number(r[0].user_version)) || 0;
    });
  }

  // 适配器允许异步（Capacitor）或同步（Node 测试），统一 await 即可兼容两者
  async function probeFts() {
    for (var i = 0; i < S.FTS_PROBES.length; i++) {
      var p = S.FTS_PROBES[i];
      try { await exec(p.sql); await exec('DROP TABLE _fts_probe'); return p.mode; }
      catch (e) { /* 试下一个 */ }
    }
    return 'like';
  }

  async function applyMigration(m) {
    await exec('BEGIN');
    try {
      for (var i = 0; i < m.up.length; i++) {
        var step = m.up[i];
        if (step.sql) await exec(step.sql);
        else if (step.fts && info.ftsMode !== 'like') {
          for (var j = 0; j < step.fts.length; j++) await exec(step.fts[j]);
        }
      }
      await exec('PRAGMA user_version = ' + m.version);
      await exec('COMMIT');
    } catch (e) {
      try { await exec('ROLLBACK'); } catch (ignored) {}
      throw new Error('迁移 v' + m.version + ' 失败: ' + e.message);
    }
  }

  async function migrate() {
    var from = await currentVersion();
    info.fromVersion = from;
    info.ftsMode = await probeFts();
    for (var i = 0; i < S.MIGRATIONS.length; i++) {
      var m = S.MIGRATIONS[i];
      if (m.version > from) await applyMigration(m);
    }
    // 升版后 chapters 已存在，才单独建 FTS 表与触发器（幂等）
    if (info.ftsMode !== 'like') {
      var has = await all("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [S.FTS_TABLE]);
      if (!has.length) {
        try {
          await exec('BEGIN');
          var stmts = S.ftsStatements(info.ftsMode === 'trigram' ? 'trigram' : 'unicode61');
          for (var k = 0; k < stmts.length; k++) await exec(stmts[k]);
          // 外部内容表不会自动索引建表前就存在的行，必须 rebuild 一次，否则旧章节检索不到
          await exec("INSERT INTO " + S.FTS_TABLE + "(" + S.FTS_TABLE + ") VALUES('rebuild')");
          await exec('COMMIT');
        } catch (e) {
          try { await exec('ROLLBACK'); } catch (ignored) {}
          info.ftsMode = 'like';   // 建不起就整库降级 LIKE
        }
      }
    }
    info.toVersion = S.LATEST_VERSION;
    return info;
  }

  async function init(adapter) {
    db = adapter;
    await exec('PRAGMA foreign_keys = ON');   // 默认是 OFF，级联删除依赖它
    return migrate();
  }

  /* ---------- 通用 CRUD 助手（复用优先，避免每表重复样板） ---------- */

  function insert(table, fields, obj) {
    var t = now();
    var vals = fields.map(function (f) { return f === 'created_at' || f === 'updated_at' ? t : obj[f]; });
    var sql = 'INSERT INTO ' + table + ' (' + fields.join(',') + ') VALUES (' +
              fields.map(function () { return '?'; }).join(',') + ')';
    return run(sql, vals).then(function (r) { return r.lastId; });
  }

  function update(table, id, fields, obj) {
    var set = fields.filter(function (f) { return f !== 'id' && f !== 'created_at'; });
    var sql = 'UPDATE ' + table + ' SET ' + set.map(function (f) { return f + '=?'; }).join(',') + ' WHERE id=?';
    var vals = set.map(function (f) { return f === 'updated_at' ? now() : obj[f]; });
    vals.push(id);
    return run(sql, vals).then(function (r) { return r.changes; });
  }

  function remove(table, id) { return run('DELETE FROM ' + table + ' WHERE id=?', [id]); }
  function getRow(table, id) { return all('SELECT * FROM ' + table + ' WHERE id=?', [id]).then(function (r) { return r[0] || null; }); }

  /* ---------- 书架 ---------- */

  var BOOK_FIELDS = ['title', 'author', 'synopsis', 'style_note', 'created_at', 'updated_at'];
  var CHAPTER_FIELDS = ['book_id', 'idx', 'title', 'body', 'summary', 'word_count', 'created_at', 'updated_at'];
  var CHAR_FIELDS = ['book_id', 'name', 'role', 'aliases', 'personality', 'speech_style', 'taboos', 'background', 'created_at', 'updated_at'];
  var TPL_FIELDS = ['kind', 'name', 'instruction', 'use_summary', 'is_builtin', 'sort_order', 'created_at', 'updated_at'];

  function listBooks() {
    return all('SELECT b.*, (SELECT COUNT(*) FROM chapters c WHERE c.book_id=b.id) AS chapter_count,' +
               '(SELECT SUM(c.word_count) FROM chapters c WHERE c.book_id=b.id) AS total_words ' +
               'FROM books b ORDER BY b.updated_at DESC', []);
  }
  function createBook(b) {
    return insert('books', BOOK_FIELDS, Object.assign({ title: '未命名', author: '', synopsis: '', style_note: '' }, b));
  }
  // 先读回原行再写回：避免界面只传部分字段时把 NOT NULL 列写成 NULL
  function updateBook(id, b) {
    return getRow('books', id).then(function (cur) {
      if (!cur) throw new Error('作品不存在: ' + id);
      return update('books', id, BOOK_FIELDS.concat(['id']), Object.assign({}, cur, b));
    });
  }
  function deleteBook(id) { return remove('books', id); }

  /* ---------- 章节 ---------- */

  function listChapters(bookId) {
    return all('SELECT id,book_id,idx,title,summary,word_count,updated_at,length(body) AS body_len ' +
               'FROM chapters WHERE book_id=? ORDER BY idx', [bookId]);
  }
  function getChapter(id) { return getRow('chapters', id); }

  function createChapter(bookId, title) {
    return all('SELECT COALESCE(MAX(idx),0)+1 AS next FROM chapters WHERE book_id=?', [bookId]).then(function (r) {
      return insert('chapters', CHAPTER_FIELDS, {
        book_id: bookId, idx: r[0].next, title: title || '', body: '', summary: '', word_count: 0
      });
    });
  }

  // 原正文为空（新建章节）时不存快照：空文没有可恢复价值，否则每章首存都会脏一条记录
  function saveChapterBody(id, body, reason) {
    return getRow('chapters', id).then(function (ch) {
      if (!ch) throw new Error('章节不存在: ' + id);
      var skip = ch.body === body || !ch.body;
      var p = skip ? Promise.resolve(null)
        : insert('snapshots', ['chapter_id', 'book_id', 'body', 'word_count', 'reason', 'created_at'],
            { chapter_id: id, book_id: ch.book_id, body: ch.body, word_count: ch.word_count, reason: reason || 'manual' });
      return p.then(function () {
        return run('UPDATE chapters SET body=?, word_count=?, updated_at=? WHERE id=?',
          [body, countWords(body), now(), id]);
      }).then(function () { return countWords(body); });
    });
  }

  // 打字自动保存（F54）专用：只更新正文/字数/时间，不生成快照——快照留给采纳/回滚这类内容替换，
  // 否则每次防抖落盘都脏一条，50 条上限会被打字冲掉、淹没真正的安全网
  function saveChapterDraft(id, body) {
    return getRow('chapters', id).then(function (ch) {
      if (!ch) throw new Error('章节不存在: ' + id);
      if (ch.body === body) return ch.word_count;    // 未变不写，省一次 IO
      return run('UPDATE chapters SET body=?, word_count=?, updated_at=? WHERE id=?',
        [body, countWords(body), now(), id]).then(function () { return countWords(body); });
    });
  }

  function saveChapterMeta(id, patch) {
    return getRow('chapters', id).then(function (ch) {
      if (!ch) throw new Error('章节不存在: ' + id);
      var title = patch.title === undefined ? ch.title : patch.title;
      var summary = patch.summary === undefined ? ch.summary : patch.summary;
      return run('UPDATE chapters SET title=?, summary=?, updated_at=? WHERE id=?', [title, summary, now(), id]);
    });
  }

  function reorderChapters(bookId, orderedIds) {
    return Promise.all(orderedIds.map(function (cid, i) {
      return run('UPDATE chapters SET idx=? WHERE id=? AND book_id=?', [i + 1, cid, bookId]);
    }));
  }

  function deleteChapter(id) { return remove('chapters', id); }

  /* ---------- 节（章的下级写作单元） ---------- */

  var SECTION_FIELDS = ['chapter_id', 'book_id', 'idx', 'title', 'body', 'summary', 'word_count', 'created_at', 'updated_at'];

  function listSections(chapterId) {
    return all('SELECT id,chapter_id,book_id,idx,title,summary,word_count,updated_at,length(body) AS body_len ' +
               'FROM sections WHERE chapter_id=? ORDER BY idx', [chapterId]);
  }
  function getSection(id) { return getRow('sections', id); }

  function createSection(chapterId, title) {
    return getRow('chapters', chapterId).then(function (ch) {
      if (!ch) throw new Error('章节不存在: ' + chapterId);
      return all('SELECT COALESCE(MAX(idx),0)+1 AS next FROM sections WHERE chapter_id=?', [chapterId]).then(function (r) {
        return insert('sections', SECTION_FIELDS, {
          chapter_id: chapterId, book_id: ch.book_id, idx: r[0].next, title: title || '', body: '', summary: '', word_count: 0
        });
      });
    });
  }

  // 节正文写回：无快照表（FK 只指向 chapters），采纳/回滚留痕仅章级提供；节级只存最新正文
  function saveSectionBody(id, body) {
    return getRow('sections', id).then(function (s) {
      if (!s) throw new Error('节不存在: ' + id);
      return run('UPDATE sections SET body=?, word_count=?, updated_at=? WHERE id=?',
        [body, countWords(body), now(), id]).then(function () { return countWords(body); });
    });
  }

  function saveSectionDraft(id, body) {
    return getRow('sections', id).then(function (s) {
      if (!s) throw new Error('节不存在: ' + id);
      if (s.body === body) return s.word_count;
      return run('UPDATE sections SET body=?, word_count=?, updated_at=? WHERE id=?',
        [body, countWords(body), now(), id]).then(function () { return countWords(body); });
    });
  }

  function saveSectionMeta(id, patch) {
    return getRow('sections', id).then(function (s) {
      if (!s) throw new Error('节不存在: ' + id);
      var title = patch.title === undefined ? s.title : patch.title;
      var summary = patch.summary === undefined ? s.summary : patch.summary;
      return run('UPDATE sections SET title=?, summary=?, updated_at=? WHERE id=?', [title, summary, now(), id]);
    });
  }

  function reorderSections(chapterId, orderedIds) {
    return Promise.all(orderedIds.map(function (sid, i) {
      return run('UPDATE sections SET idx=? WHERE id=? AND chapter_id=?', [i + 1, sid, chapterId]);
    }));
  }

  function deleteSection(id) { return remove('sections', id); }

  /* ---------- 快照与回滚 ---------- */

  function listSnapshots(chapterId) {
    return all('SELECT id,chapter_id,word_count,reason,created_at,length(body) AS body_len ' +
               'FROM snapshots WHERE chapter_id=? ORDER BY created_at DESC', [chapterId]);
  }
  function getSnapshot(id) { return getRow('snapshots', id); }

  // 回滚本身也可回滚：先给当前正文存一份快照，再写回历史版本
  function rollback(snapshotId) {
    return getRow('snapshots', snapshotId).then(function (snap) {
      if (!snap) throw new Error('快照不存在: ' + snapshotId);
      return saveChapterBody(snap.chapter_id, snap.body, 'before_rollback');
    });
  }

  /* ---------- 角色卡 ---------- */

  function listCharacters(bookId) {
    return all('SELECT * FROM characters WHERE book_id=? ORDER BY name', [bookId]);
  }
  function saveCharacter(bookId, c, id) {
    var obj = {
      book_id: bookId, name: c.name, role: c.role || '',
      aliases: JSON.stringify(c.aliases || []),
      personality: c.personality || '', speech_style: c.speech_style || '',
      taboos: c.taboos || '', background: c.background || ''
    };
    return id ? update('characters', id, CHAR_FIELDS.concat(['id']), obj) : insert('characters', CHAR_FIELDS, obj);
  }
  function deleteCharacter(id) { return remove('characters', id); }

  /* ---------- 势力（书内阵营设定） ---------- */

  var FACTION_FIELDS = ['book_id', 'name', 'kind', 'intro', 'created_at', 'updated_at'];
  function listFactions(bookId) {
    return all('SELECT * FROM factions WHERE book_id=? ORDER BY name', [bookId]);
  }
  function saveFaction(bookId, f, id) {
    var obj = { book_id: bookId, name: f.name, kind: f.kind || '', intro: f.intro || '' };
    return id ? update('factions', id, FACTION_FIELDS.concat(['id']), obj) : insert('factions', FACTION_FIELDS, obj);
  }
  function deleteFaction(id) { return remove('factions', id); }

  /* ---------- 模板 ---------- */

  function listTemplates() { return all('SELECT * FROM templates ORDER BY sort_order, id', []); }
  function saveTemplate(t, id) {
    var obj = { kind: t.kind, name: t.name, instruction: t.instruction,
                use_summary: t.use_summary ? 1 : 0, is_builtin: t.is_builtin ? 1 : 0, sort_order: t.sort_order || 0 };
    return id ? update('templates', id, TPL_FIELDS.concat(['id']), obj) : insert('templates', TPL_FIELDS, obj);
  }
  function deleteTemplate(id) { return remove('templates', id); }

  /* ---------- 设定（分组 JSON，密钥永不入库） ---------- */

  function getSetting(key) {
    return all('SELECT value_json FROM settings WHERE key=?', [key]).then(function (r) {
      var def = S.DEFAULT_SETTINGS[key];
      if (!r.length) return def === undefined ? null : JSON.parse(JSON.stringify(def));
      var saved = JSON.parse(r[0].value_json);
      var merged = def && typeof def === 'object' && !Array.isArray(def)
        ? Object.assign(JSON.parse(JSON.stringify(def)), saved)   // 新增键自动补齐默认值
        : saved;
      // AI 结果永不自动采纳：不给界面开关，写入 true 也强制改回
      if (key === 'ai_context') merged.auto_adopt = false;
      return merged;
    });
  }

  function setSetting(key, value) {
    var v = key === 'ai_context' ? Object.assign({}, value, { auto_adopt: false }) : value;
    return run('INSERT INTO settings (key,value_json,updated_at) VALUES (?,?,?) ' +
               'ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at',
      [key, JSON.stringify(v), now()]);
  }

  /* ---------- AI 用量与失败记录 ---------- */

  function startJob(job) {
    return insert('ai_jobs', ['book_id', 'chapter_id', 'kind', 'provider', 'model', 'status',
                             'prompt_chars', 'output_chars', 'error', 'created_at', 'finished_at'],
      Object.assign({ status: 'running', prompt_chars: 0, output_chars: 0, error: '' }, job));
  }
  function finishJob(id, patch) {
    return run('UPDATE ai_jobs SET status=?, output_chars=?, error=?, finished_at=? WHERE id=?',
      [patch.status, patch.output_chars || 0, patch.error || '', now(), id]);
  }
  function listJobs(limit) {
    return all('SELECT * FROM ai_jobs ORDER BY id DESC LIMIT ?', [limit || 50]);
  }

  /* ---------- 一致性报告 / 伏笔 / 时间线 ---------- */

  function addIssues(bookId, chapterId, jobId, items) {
    return Promise.all((items || []).map(function (it) {
      return insert('consistency_issues', ['book_id', 'chapter_id', 'job_id', 'quote', 'type',
                                          'problem', 'suggestion', 'status', 'created_at'],
        { book_id: bookId, chapter_id: chapterId, job_id: jobId, quote: it.quote || '',
          type: it.type || '', problem: it.problem, suggestion: it.suggestion || '', status: 'open' });
    }));
  }
  function listIssues(bookId, status) {
    return status
      ? all('SELECT * FROM consistency_issues WHERE book_id=? AND status=? ORDER BY id DESC', [bookId, status])
      : all('SELECT * FROM consistency_issues WHERE book_id=? ORDER BY id DESC', [bookId]);
  }
  function setIssueStatus(id, status) {
    return run('UPDATE consistency_issues SET status=? WHERE id=?', [status, id]);
  }

  var THREAD_FIELDS = ['book_id', 'title', 'detail', 'planted_chapter_id', 'status',
                       'payoff_chapter_id', 'due_hint', 'created_at', 'updated_at'];
  function listThreads(bookId, status) {
    return status
      ? all('SELECT * FROM plot_threads WHERE book_id=? AND status=? ORDER BY id', [bookId, status])
      : all('SELECT * FROM plot_threads WHERE book_id=? ORDER BY id', [bookId]);
  }
  function saveThread(bookId, t, id) {
    var obj = Object.assign({ title: '', detail: '', status: 'open', due_hint: '' }, t, { book_id: bookId });
    return id ? update('plot_threads', id, THREAD_FIELDS.concat(['id']), obj) : insert('plot_threads', THREAD_FIELDS, obj);
  }
  function deleteThread(id) { return remove('plot_threads', id); }

  var EVENT_FIELDS = ['book_id', 'when_label', 'chapter_id', 'title', 'detail',
                      'character_names', 'sort_key', 'created_at'];
  function listEvents(bookId) {
    return all('SELECT * FROM timeline_events WHERE book_id=? ORDER BY sort_key, id', [bookId]);
  }
  function saveEvent(bookId, e, id) {
    var obj = Object.assign({ title: '', when_label: '', detail: '', character_names: '', sort_key: '' }, e, { book_id: bookId });
    return id ? update('timeline_events', id, EVENT_FIELDS.concat(['id']), obj) : insert('timeline_events', EVENT_FIELDS, obj);
  }
  function deleteEvent(id) { return remove('timeline_events', id); }

  /* ---------- 全文检索（trigram / fts5 / LIKE 三级） ---------- */

  function useFts(q) {
    if (info.ftsMode === 'like') return false;
    var len = Array.from(q || '').length;
    if (len === 0) return false;
    if (info.ftsMode === 'trigram') return len >= 3;          // trigram 不足 3 字无法命中
    return !/[\u3400-\u9FFF\uF900-\uFAFF]/.test(q);          // unicode61 不对中文分词，中文走 LIKE
  }

  function search(bookId, q, limit) {
    var max = limit || 50;
    if (useFts(q)) {
      var phrase = '"' + String(q).replace(/"/g, '""') + '"';
      // SQL 字符串常量只能用单引号；snippet 的分界符若写成 "[" 会被当成列名报 no such column
      return all("SELECT c.id, c.idx, c.title, c.book_id, " +
                 "snippet(" + S.FTS_TABLE + ", 1, '[', ']', '\u2026', 16) AS sn " +
                 "FROM " + S.FTS_TABLE + " f JOIN chapters c ON c.id = f.rowid " +
                 "WHERE " + S.FTS_TABLE + " MATCH ? AND c.book_id = ? ORDER BY rank LIMIT ?",
        [phrase, bookId, max]).then(function (rows) {
          return rows.map(function (r) { return Object.assign({}, r, { engine: info.ftsMode }); });
        });
    }
    return all('SELECT id, idx, title, book_id, ' +
               'substr(body, max(1, instr(body, ?) - 20), 60) AS sn ' +
               'FROM chapters WHERE book_id = ? AND (body LIKE ? OR title LIKE ?) ORDER BY idx LIMIT ?',
      [q, bookId, '%' + q + '%', '%' + q + '%', max])
        .then(function (rows) { return rows.map(function (r) { return Object.assign({}, r, { engine: 'like' }); }); });
  }

  /* ---------- 统计 ---------- */

  function stats(bookId) {
    return all('SELECT (SELECT COUNT(*) FROM books) AS books,' +
               '(SELECT COUNT(*) FROM chapters WHERE book_id=?) AS chapters,' +
               '(SELECT COALESCE(SUM(word_count),0) FROM chapters WHERE book_id=?) AS words,' +
               '(SELECT COUNT(*) FROM snapshots WHERE book_id=?) AS snapshots,' +
               '(SELECT COUNT(*) FROM characters WHERE book_id=?) AS characters,' +
               "(SELECT COUNT(*) FROM plot_threads WHERE book_id=? AND status='open') AS open_threads," +
               "(SELECT COUNT(*) FROM consistency_issues WHERE book_id=? AND status='open') AS open_issues," +
               "(SELECT COUNT(*) FROM ai_jobs WHERE book_id=? AND status='failed') AS failed_jobs",
      [bookId, bookId, bookId, bookId, bookId, bookId, bookId]);
  }

  root.NOVEL_DB = {
    init: init, migrate: migrate, info: function () { return info; },
    countWords: countWords,
    listBooks: listBooks, createBook: createBook, updateBook: updateBook, deleteBook: deleteBook,
    listChapters: listChapters, getChapter: getChapter, createChapter: createChapter,
    saveChapterBody: saveChapterBody, saveChapterDraft: saveChapterDraft, saveChapterMeta: saveChapterMeta,
    reorderChapters: reorderChapters, deleteChapter: deleteChapter,
    listSections: listSections, getSection: getSection, createSection: createSection,
    saveSectionBody: saveSectionBody, saveSectionDraft: saveSectionDraft, saveSectionMeta: saveSectionMeta,
    reorderSections: reorderSections, deleteSection: deleteSection,
    listSnapshots: listSnapshots, getSnapshot: getSnapshot, rollback: rollback,
    listCharacters: listCharacters, saveCharacter: saveCharacter, deleteCharacter: deleteCharacter,
    listFactions: listFactions, saveFaction: saveFaction, deleteFaction: deleteFaction,
    listTemplates: listTemplates, saveTemplate: saveTemplate, deleteTemplate: deleteTemplate,
    getSetting: getSetting, setSetting: setSetting,
    startJob: startJob, finishJob: finishJob, listJobs: listJobs,
    addIssues: addIssues, listIssues: listIssues, setIssueStatus: setIssueStatus,
    listThreads: listThreads, saveThread: saveThread, deleteThread: deleteThread,
    listEvents: listEvents, saveEvent: saveEvent, deleteEvent: deleteEvent,
    search: search, stats: stats
  };
})(globalThis);
