/* 界面视图（M4，F01–F07/F09/F11/F22/F32/F50）：以字符串模板渲染 + 事件委托，无框架无打包器。
   依赖全局 NOVEL_APP 与逻辑模块；真正干活的编排都在 NOVEL_SESSION，视图只做输入/展示，
   凡涉正文写回一律经 DB（采纳→saveChapterBody 自动快照；打字→saveChapterDraft 静默）。 */
(function (root) {
  'use strict';

  var DB = root.NOVEL_DB;
  function App() { return root.NOVEL_APP; }
  function screen() { return root.NOVEL_APP.el; }
  function esc(s) { return root.NOVEL_UTIL.escapeHtml(s); }
  function q(sel) { return screen().querySelector(sel); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

  // 复制到剪贴板：优先 navigator.clipboard，失败降级临时 textarea + execCommand
  function copyText(t) {
    t = String(t == null ? '' : t);
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
        root.navigator.clipboard.writeText(t).then(function () { App().toast('已复制', 'ok'); },
          function () { App().toast('复制失败', 'bad'); });
        return;
      }
    } catch (e) { /* 无权限/非安全上下文，走降级 */ }
    try {
      var ta2 = root.document.createElement('textarea'); ta2.value = t;
      ta2.style.position = 'fixed'; ta2.style.opacity = '0'; root.document.body.appendChild(ta2); ta2.select();
      root.document.execCommand('copy'); root.document.body.removeChild(ta2); App().toast('已复制', 'ok');
    } catch (e) { App().toast('复制失败', 'bad'); }
  }

  var BUILTIN = [
    { kind: 'polish', name: '润色', instruction: '在保持原意、人称与专有名词的前提下，让文字更凝练、更有画面感。只输出润色后的正文（将整体替换所选），不要复述原文、不解释、不加标题。' },
    { kind: 'expand', name: '扩写', instruction: '在不改变剧情的前提下，扩写动作、感官与心理细节，篇幅约为原文的 1.5–2 倍。只输出扩写后的正文（将整体替换所选），不要附写作说明。' },
    { kind: 'condense', name: '缩写', instruction: '压缩冗余表述，保留关键情节、所有伏笔信息与全部人物对话要点，篇幅约为原文的一半。只输出压缩后的正文（将整体替换所选）。' },
    { kind: 'dialogue', name: '转对话', instruction: '把叙述改写为人物对话，突出各自语气与潜台词，不要添加旁白解释。只输出改写后的对话正文（将整体替换所选）。' },
    { kind: 'continue', name: '续写', instruction: '紧接选段结尾自然续写，保持文风、人称与人设一致。只输出新续写的正文，切勿重复选段里已有的文字，不总结、不预告后事。' }
  ];

  function head(title, backHash) {
    return '<header class="bar">'
      + (backHash ? '<button class="back" data-back="' + esc(backHash) + '">‹ 返回</button>' : '<span class="brand">AI 写作助手</span>')
      + '<h1 class="htitle">' + esc(title) + '</h1><span class="sp"></span></header>';
  }
  // 全局返回：[data-back] 与系统返回键共用 App().navigateUp() 单一入口（行为严格一致）；
  // data-back 作为精确目标 hint 传入，无 hint 时 navigateUp 自行从当前 hash 逐级推导。
  function wireBack() {
    [].forEach.call(screen().querySelectorAll('[data-back]'), function (b) {
      on(b, 'click', function () { App().navigateUp(b.getAttribute('data-back')); });
    });
  }
  function findBook(bookId) {
    return DB.listBooks().then(function (bs) {
      for (var i = 0; i < bs.length; i++) if (String(bs[i].id) === String(bookId)) return bs[i];
      return null;
    });
  }

  /* ============ 通用底部弹层（取代 window.prompt/confirm，修复真机主线程死锁） ============
     真机 Capacitor WebView 里 window.prompt/confirm 会阻塞渲染线程直至 JsResult 回传，
     而宿主未及时回传即永久卡死（上一轮已实测）。一律改用页面内 .sheet。 */
  function ensureSheet(id) {
    var sheet = q('#' + id);
    if (!sheet) {
      var d = document.createElement('div');
      d.className = 'sheet'; d.id = id; d.hidden = true;
      d.innerHTML = '<div class="mask" data-closesheet></div><div class="panel"></div>';
      screen().appendChild(d);
      on(d.querySelector('[data-closesheet]'), 'click', function () { d.hidden = true; });   // 遮罩只绑一次，避免重开时监听器泄漏
      sheet = d;   // 关键：新建后必须返回新节点，否则 openSheet 对 null 设 hidden 抛错、弹层永不开
    }
    return sheet;
  }
  function openSheet(id, html) {
    var s = ensureSheet(id); s.hidden = false;
    var panel = s.querySelector('.panel'); panel.innerHTML = html;
    var cancel = panel.querySelector('[data-closesheet]');
    on(cancel, 'click', function () { s.hidden = true; });
    return panel;
  }
  function closeSheet(id) { var s = q('#' + id); if (s) s.hidden = true; }

  // 表单弹层：fields=[{key,label,value,type,rows,options,ph}]；onSubmit(vals) 返 Promise，成功自动关闭
  function sheetForm(title, fields, onSubmit) {
    var body = fields.map(function (f, i) {
      var val = f.value == null ? '' : String(f.value);
      if (f.type === 'textarea')
        return '<div class="fld"><label>' + esc(f.label) + '</label><textarea data-fi="' + i + '" rows="' + (f.rows || 3) + '" placeholder="' + esc(f.ph || '') + '">' + esc(val) + '</textarea></div>';
      if (f.type === 'select')
        return '<div class="fld"><label>' + esc(f.label) + '</label><select data-fi="' + i + '">' + (f.options || []).map(function (o) {
          return '<option value="' + esc(o) + '"' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select></div>';
      return '<div class="fld"><label>' + esc(f.label) + '</label><input data-fi="' + i + '" type="' + (f.type || 'text') + '" value="' + esc(val) + '" placeholder="' + esc(f.ph || '') + '"></div>';
    }).join('');
    var panel = openSheet('formSheet', '<div class="sh-title">' + esc(title) + '</div><div class="form">' + body
      + '<div class="row"><button class="primary" data-sfok>保存</button><button data-sfcont>保存并继续</button><button class="ghost" data-closesheet>取消</button></div></div>');
    function grabVals() {
      var vals = {};
      fields.forEach(function (f, i) { var e = panel.querySelector('[data-fi="' + i + '"]'); vals[f.key] = e ? String(e.value).trim() : ''; });
      return vals;
    }
    function clearForm() {
      fields.forEach(function (f, i) { var e = panel.querySelector('[data-fi="' + i + '"]'); if (e) { if (f.type === 'select' && f.options && f.options.length) e.value = f.options[0]; else e.value = ''; } });
    }
    var ok = panel.querySelector('[data-sfok]');
    var cont = panel.querySelector('[data-sfcont]');
    on(ok, 'click', function () {
      var vals = grabVals();
      if (fields[0] && !vals[fields[0].key]) { App().toast((fields[0].label || '首项') + '不能为空', 'warn'); return; }
      ok.disabled = cont.disabled = true;
      Promise.resolve(onSubmit(vals)).then(function () { closeSheet('formSheet'); },
        function (e) { ok.disabled = cont.disabled = false; App().toast('保存失败：' + ((e && e.message) || e), 'bad'); });
    });
    on(cont, 'click', function () {
      var vals = grabVals();
      if (fields[0] && !vals[fields[0].key]) { App().toast((fields[0].label || '首项') + '不能为空', 'warn'); return; }
      ok.disabled = cont.disabled = true;
      Promise.resolve(onSubmit(vals)).then(function () {
        ok.disabled = cont.disabled = false;
        clearForm();
        App().toast('已保存，可继续添加', 'ok');
      }, function (e) { ok.disabled = cont.disabled = false; App().toast('保存失败：' + ((e && e.message) || e), 'bad'); });
    });
  }
  // 确认弹层（取代 window.confirm）
  function confirmSheet(title, msg, onYes) {
    var panel = openSheet('confirmSheet', '<div class="sh-title">' + esc(title) + '</div><div class="note">' + esc(msg) + '</div>'
      + '<div class="row"><button class="primary" data-cfy>确定</button><button class="ghost" data-closesheet>取消</button></div>');
    on(panel.querySelector('[data-cfy]'), 'click', function () { closeSheet('confirmSheet'); onYes(); });
  }

  // 列表行工具：按 id 找行 / 带确认删除
  function findRow(rows, id) { for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === String(id)) return rows[i]; return null; }
  function delRow(doDel, after, label) {
    confirmSheet('删除' + label, '确定删除？此操作不可撤销。', function () {
      Promise.resolve(doDel()).then(function () { after(); App().toast('已删除', 'ok'); },
        function (e) { App().toast('删除失败：' + ((e && e.message) || e), 'bad'); });
    });
  }

  // 回收站（F-软删）：三层删除按钮 → 二次确认 → 软删除标记（不搬内容、不落 temp/）。
  // 保留天数沿用存储设置 temp_keep_days（默认 7）；kind ∈ book/chapter/section。
  var TRASH_KINDS = {
    book: { label: '作品', trash: 'trashBook', restore: 'restoreBook' },
    chapter: { label: '章节', trash: 'trashChapter', restore: 'restoreChapter' },
    section: { label: '节', trash: 'trashSection', restore: 'restoreSection' }
  };
  function delToTrash(kind, id, title, after) {
    var k = TRASH_KINDS[kind];
    if (!k) { App().toast('未知删除类型', 'bad'); return; }
    id = Number(id);
    DB.getSetting('storage').catch(function () { return null; }).then(function (stg) {
      var days = (stg && stg.temp_keep_days) || 7;
      confirmSheet('移入回收站', '「' + (title || '未命名') + '」' + k.label + '将移入回收站，保留 ' + days + ' 天，期间可在“我的 › 存储 › 回收站”恢复。', function () {
        Promise.resolve(DB[k.trash](id)).then(function () {
          App().toast('已移入回收站', 'ok');
          if (after) after();
        }, function (e) { App().toast('删除失败：' + ((e && e.message) || e), 'bad'); });
      });
    });
  }
  // 遍历 [data-trash] 绑定删除：stopPropagation 防止触发整卡 data-open 导航
  function wireCardTrash(scope, after) {
    [].forEach.call((scope || screen()).querySelectorAll('[data-trash]'), function (btn) {
      on(btn, 'click', function (e) {
        e.stopPropagation();
        delToTrash(btn.getAttribute('data-kind'), btn.getAttribute('data-id'), btn.getAttribute('data-title'), after);
      });
    });
  }

  // 数据操作（导出/导入/备份/恢复/统计）的注入依赖；DA 懒取，确保脚本加载顺序无关
  function DA() { return root.NOVEL_DATA_ACTIONS; }
  function dataDeps() {
    return { db: DB, adapter: root.NOVEL_ADAPTER, temp: root.NOVEL_TEMP, secure: root.NOVEL_SECURE };
  }
  function needTemp() {
    if (!(root.NOVEL_TEMP && root.NOVEL_TEMP.isReady && root.NOVEL_TEMP.isReady())) { App().toast('暂存层未就绪（需原生 Filesystem）', 'warn'); return false; }
    if (!root.NOVEL_ADAPTER) { App().toast('数据库适配器未就绪', 'warn'); return false; }
    return true;
  }

  /* ================= 书架 F01 ================= */
  function shelf() {
    return DB.listBooks().then(function (books) {
      var html = head('书架') + '<div class="body">'
        + '<div class="row"><button class="primary" id="newBook">＋ 新建作品</button></div>'
        + (books.length ? '<ul class="list">' + books.map(function (b) {
            return '<li class="card" data-open="#/book/' + b.id + '">'
              + '<div class="ct">' + esc(b.title || '未命名') + '</div>'
              + '<div class="cs">' + esc(b.author || '') + ' · ' + esc(b.synopsis || '（暂无简介）').slice(0, 40) + '</div>'
              + '<div class="card-foot"><button class="btn-del" data-trash data-kind="book" data-id="' + b.id + '" data-title="' + esc(b.title || '未命名') + '">🗑 删除</button></div></li>';
          }).join('') + '</ul>' : '<p class="muted">还没有作品，点上面新建一部开始。</p>')
        + '</div>';
      screen().innerHTML = html;
      wireBack();
      on(q('#newBook'), 'click', function () {
        sheetForm('新建作品', [{ key: 'title', label: '作品标题', value: '我的小说' }], function (v) {
          return DB.createBook({ title: v.title }).then(function (id) { App().go('#/book/' + id); });
        });
      });
      [].forEach.call(screen().querySelectorAll('[data-open]'), function (li) {
        on(li, 'click', function () { App().go(li.getAttribute('data-open')); });
      });
      wireCardTrash(screen(), function () { App().render(); });
    });
  }

  /* ================= 作品详情 F02/F03：竖向分段（章节/人物设定/剧情走向/势力介绍/作品信息） ================= */
  var BOOK_TABS = [
    { key: 'chapters', label: '章节' },
    { key: 'chars', label: '人物设定' },
    { key: 'plot', label: '剧情走向' },
    { key: 'faction', label: '势力介绍' },
    { key: 'info', label: '作品信息' }
  ];

  function book(p) {
    var bookId = p.bookId;
    var tab = p.tab || 'chapters';
    return findBook(bookId).then(function (bk) {
      if (!bk) { screen().innerHTML = head('作品') + '<div class="err">作品不存在，可能已删除。</div>'; wireBack(); return; }
      App().state.bookId = bookId;
      var navHtml = BOOK_TABS.map(function (t) {
        return '<button class="vbtn' + (t.key === tab ? ' active' : '') + '" data-tab-nav="' + t.key + '">' + esc(t.label) + '</button>';
      }).join('');
      screen().innerHTML = head(bk.title || '作品', '#/shelf')
        + '<div class="vwrap"><nav class="vnav">' + navHtml + '</nav><div class="vpanel" id="bookBody"></div></div>';
      screen().classList.add('screen--dual');   // 双栏左右独立滚动（§4-D）
      wireBack();
      [].forEach.call(screen().querySelectorAll('[data-tab-nav]'), function (b) {
        on(b, 'click', function () { App().go('#/book/' + bookId + '/' + b.getAttribute('data-tab-nav')); });
      });
      var body = q('#bookBody');
      if (tab === 'chars') renderBookChars(body, bookId);
      else if (tab === 'plot') renderBookPlot(body, bookId);
      else if (tab === 'faction') renderBookFaction(body, bookId);
      else if (tab === 'info') renderBookInfo(body, bk, bookId);
      else renderBookChapters(body, bk, bookId);
    });
  }

  // ---- 章节（默认分段，保留旧列表 + 新建 + 导出）----
  // 头部上下结构（建议 1）：标题独占一行，操作按钮另起一行左对齐，不再用 .secrow 左右两端顶挤。
  function renderBookChapters(body, bk, bookId) {
    DB.listChapters(bookId).then(function (chs) {
      var head = '<div class="sec-head"><span class="st">章节（' + chs.length + '）</span></div>'
        + '<div class="sec-actions">'
        + (chs.length ? '<button class="primary" id="newCh">＋ 新建</button>' : '')
        + '<button id="exportBtn">⬇ 导出</button></div>';
      var list = chs.length
        ? '<ul class="list">' + chs.map(function (c) {
            return '<li class="card" data-open="#/chapter/' + c.id + '">'
              + '<div class="ct">' + (c.idx) + '. ' + esc(c.title || '（无题）') + '</div>'
              + '<div class="cs">' + (c.word_count || 0) + ' 字' + (c.summary ? ' · 有摘要' : '') + ' · 点击进入</div>'
              + '<div class="card-foot"><button class="btn-del" data-trash data-kind="chapter" data-id="' + c.id + '" data-title="' + esc(c.title || '（无题）') + '">🗑 删除</button></div></li>';
          }).join('') + '</ul>'
        : '<div class="empty-hero"><div class="eh-ic">📖</div><div class="eh-t">还没有章节</div>'
          + '<div class="eh-d">一本书从第一章开始。章节下可继续拆分“节”，也可直接写作本章正文。</div>'
          + '<button class="primary eh-btn" id="newCh">＋ 创建第一章</button></div>';
      body.innerHTML = head + list;
      [].forEach.call(body.querySelectorAll('[data-open]'), function (li) {
        on(li, 'click', function () { App().go(li.getAttribute('data-open')); });
      });
      wireCardTrash(body, function () { App().render(); });
      on(q('#newCh'), 'click', function () {
        DB.createChapter(bookId, '第' + (chs.length + 1) + '章').then(function (id) { App().go('#/chapter/' + id); },
          function (e) { App().toast('创建章节失败：' + ((e && e.message) || e), 'bad'); });
      });
      on(q('#exportBtn'), 'click', function () { openExportSheet(bk, bookId); });
    });
  }

  /* ================= 章详情（节列表：章 > 节） ================= */
  function chapter(p) {
    var chapterId = p.chapterId;
    return DB.getChapter(chapterId).then(function (ch) {
      if (!ch) { screen().innerHTML = head('章节') + '<div class="err">章节不存在或已被删除。</div>'; wireBack(); return; }
      var bookId = ch.book_id;
      App().state.bookId = bookId; App().state.chapterId = chapterId;
      return DB.listSections(chapterId).then(function (secs) {
        screen().innerHTML = head(ch.title || '章节', '#/book/' + bookId + '/chapters')
          + '<div class="body">'
          + '<div class="sec-head"><span class="st">' + esc(ch.title || ('第' + ch.idx + '章')) + ' · ' + secs.length + ' 节</span></div>'
          + (secs.length ? '<div class="sec-actions"><button class="primary" id="newSec">＋ 新建节</button></div>' : '')
          + '<div class="row"><button class="ghost" id="editChBody">✎ 直接写本章正文</button></div>'
          + (secs.length
              ? '<ul class="list">' + secs.map(function (s) {
                  return '<li class="card" data-open="#/section/' + chapterId + '/' + s.id + '">'
                    + '<div class="ct">' + s.idx + '. ' + esc(s.title || '（无题）') + '</div>'
                    + '<div class="cs">' + (s.word_count || 0) + ' 字' + (s.summary ? ' · 有摘要' : '') + '</div>'
                    + '<div class="card-foot"><button class="btn-del" data-trash data-kind="section" data-id="' + s.id + '" data-title="' + esc(s.title || '（无题）') + '">🗑 删除</button></div></li>';
                }).join('') + '</ul>'
              : '<div class="empty-hero"><div class="eh-ic">📑</div><div class="eh-t">这一章还没有节</div>'
                + '<div class="eh-d">把长章拆成若干小节更好推进；也可点上方“直接写本章正文”不分节。</div>'
                + '<button class="primary eh-btn" id="newSec">＋ 创建第一节</button></div>')
          + '</div>';
        wireBack();
        [].forEach.call(screen().querySelectorAll('[data-open]'), function (li) {
          on(li, 'click', function () { App().go(li.getAttribute('data-open')); });
        });
        wireCardTrash(screen(), function () { App().render(); });
        on(q('#newSec'), 'click', function () {
          DB.createSection(chapterId, '第' + (secs.length + 1) + '节').then(function (id) {
            App().go('#/section/' + chapterId + '/' + id);
          }, function (e) { App().toast('创建节失败：' + ((e && e.message) || e), 'bad'); });
        });
        on(q('#editChBody'), 'click', function () { App().go('#/editor/' + bookId + '/' + chapterId); });
      });
    });
  }

  // 导出成功弹层（建议 4）：不再用瞬时 toast 收尾，明确告知格式/文件名清单/落点路径，
  // 并提供“分享／保存到手机”（原生 Share+Filesystem 可用时）与“复制路径”后续动作。
  // 落点口径与“存储”页一致：应用私有目录 / temp / export/。
  function nativeSharePlugins() {
    var P = root.Capacitor && root.Capacitor.Plugins;
    return (P && P.Share && P.Filesystem) ? { share: P.Share, fs: P.Filesystem } : null;
  }
  function showExportDone(bk, r) {
    var fmtName = { txt: '纯文本 txt', docx: 'Word docx', zip: '作品包 zip' }[r.format] || r.format;
    var NS = nativeSharePlugins();
    var html = '<div class="sh-title">导出成功 · ' + esc(fmtName) + '</div>'
      + '<ul class="list">' + r.files.map(function (f) {
          return '<li class="card"><div class="ct">' + esc(f.name) + '</div>'
            + '<div class="cs">' + esc(f.rel) + (f.bytes ? ' · ' + Math.max(1, Math.round(f.bytes / 1024)) + ' KB' : '') + '</div></li>';
        }).join('') + '</ul>'
      + '<div class="note">文件落在<b>应用私有目录 / temp / export/</b>（即上方列表中的路径，相对应用数据根目录）。'
      + '私有目录不向系统文件管理器开放，找不到文件属正常现象：请点“分享／保存到手机”写入手机存储，或复制路径在应用内查看。</div>'
      + '<div class="row">'
      + (NS ? '<button class="primary" data-exshare>分享／保存到手机</button>' : '')
      + '<button data-excopy>复制路径</button><button class="ghost" data-closesheet>知道了</button></div>'
      + (NS ? '' : '<div class="hint">本机未接入原生分享，可先用“复制路径”记下位置，待原生层接入后可一键另存到手机。</div>');
    var panel = openSheet('exportDone', html);
    var firstRel = r.files.length ? r.files[0].rel : 'temp/export/';
    on(panel.querySelector('[data-excopy]'), 'click', function () { copyText(firstRel); });
    var sb = panel.querySelector('[data-exshare]');
    on(sb, 'click', function () {
      sb.disabled = true;
      // temp 相对路径 → Filesystem.getUri 解析为绝对 file:// URI → 系统分享面板（可另存 Downloads/云盘）
      Promise.all(r.files.map(function (f) { return NS.fs.getUri({ path: f.rel, directory: 'data' }); }))
        .then(function (uris) {
          return NS.share({ files: uris.map(function (u) { return u.uri; }), dialogTitle: '导出《' + (bk.title || '作品') + '》' });
        })
        .then(function () { sb.disabled = false; }, function (e) {
          sb.disabled = false; App().toast('分享失败：' + ((e && e.message) || e) + '，可先复制路径', 'bad');
        });
    });
  }

  // 导出弹层（F41/42/44）：txt / docx / 作品包 zip；txt 可勾选同时出分章
  function openExportSheet(bk, bookId) {
    var panel = openSheet('exSheet', '<div class="sh-title">导出《' + esc(bk.title || '作品') + '》</div><ul class="list">'
      + '<li class="opt" data-fmt="txt">纯文本 txt（投稿用）</li>'
      + '<li class="opt" data-fmt="docx">Word docx（每章起新页・中文排版）</li>'
      + '<li class="opt" data-fmt="zip">作品包 zip（txt+分章+角色卡+结构）</li></ul>'
      + '<label class="switch"><div><b>txt 同时导出分章文件</b></div><input type="checkbox" id="exSplit"></label>'
      + '<button class="ghost block" data-closesheet>取消</button>');
    [].forEach.call(panel.querySelectorAll('[data-fmt]'), function (li) {
      on(li, 'click', function () {
        var split = panel.querySelector('#exSplit') && panel.querySelector('#exSplit').checked;
        closeSheet('exSheet');
        if (!needTemp()) return;
        App().toast('正在导出…');
        DA().exportBook(dataDeps(), { bookId: bookId, format: li.getAttribute('data-fmt'), splitChapters: split })
          .then(function (r) { showExportDone(bk, r); },
                function (e) { App().toast('导出失败：' + (e.message || e) + '，可重试', 'bad'); });
      });
    });
  }

  // ---- 人物设定 ----
  function renderBookChars(body, bookId) {
    DB.listCharacters(bookId).then(function (rows) {
      var head = '<div class="secrow"><span class="st">人物设定（' + rows.length + '）</span>'
        + (rows.length ? '<button class="primary" id="addChar">＋ 新增</button>' : '') + '</div>';
      var list = rows.length ? rows.map(function (c) {
            var bits = [];
            if (c.personality) bits.push('性格：' + esc(clip(c.personality, 60)));
            if (c.speech_style) bits.push('说话：' + esc(clip(c.speech_style, 40)));
            return '<div class="item"><div class="it-h"><span class="it-t">' + esc(c.name || '（无名）') + '</span>'
              + (c.role ? '<span class="tag">' + esc(c.role) + '</span>' : '') + '</div>'
              + (bits.length ? '<div class="it-b">' + bits.join('<br>') + '</div>' : '')
              + '<div class="it-actions"><button class="ghost" data-edit="' + c.id + '">编辑</button>'
              + '<button class="ghost" data-del="' + c.id + '">删除</button></div></div>';
          }).join('')
        : '<div class="empty-hero"><div class="eh-ic">👤</div><div class="eh-t">还没有人物</div>'
          + '<div class="eh-d">人物卡会帮助 AI 在命中角色时保持说话风格/禁忌一致。推荐至少录入主角与主要反派。</div>'
          + '<button class="primary eh-btn" id="addChar">＋ 创建第一个人物</button></div>';
      body.innerHTML = head + list;
      function form(c) {
        c = c || {};
        var aliases = c.aliases ? (typeof c.aliases === 'string' ? JSON.parse(c.aliases || '[]') : c.aliases) : [];
        sheetForm(c.id ? '编辑人物' : '新增人物', [
          { key: 'name', label: '名字', value: c.name || '' },
          { key: 'role', label: '定位（主角/配角/反派…）', value: c.role || '' },
          { key: 'personality', label: '性格', type: 'textarea', value: c.personality || '' },
          { key: 'speech_style', label: '说话风格', type: 'textarea', value: c.speech_style || '' },
          { key: 'taboos', label: '禁忌/口癖', type: 'textarea', value: c.taboos || '' },
          { key: 'background', label: '背景', type: 'textarea', value: c.background || '' }
        ], function (v) {
          return DB.saveCharacter(bookId, { name: v.name, role: v.role, personality: v.personality,
            speech_style: v.speech_style, taboos: v.taboos, background: v.background, aliases: aliases }, c.id)
            .then(function () { renderBookChars(body, bookId); });
        });
      }
      on(q('#addChar'), 'click', function () { form(null); });
      [].forEach.call(body.querySelectorAll('[data-edit]'), function (b) {
        on(b, 'click', function () { form(findRow(rows, b.getAttribute('data-edit'))); });
      });
      [].forEach.call(body.querySelectorAll('[data-del]'), function (b) {
        on(b, 'click', function () { delRow(function () { return DB.deleteCharacter(b.getAttribute('data-del')); }, function () { renderBookChars(body, bookId); }, '人物'); });
      });
    });
  }

  // ---- 剧情走向（伏笔/线索）----
  function renderBookPlot(body, bookId) {
    DB.listThreads(bookId).then(function (rows) {
      var head = '<div class="secrow"><span class="st">剧情走向（' + rows.length + '）</span>'
        + (rows.length ? '<button class="primary" id="addPlot">＋ 新增</button>' : '') + '</div>';
      var list = rows.length ? rows.map(function (t) {
            var bits = [];
            if (t.detail) bits.push(esc(clip(t.detail, 80)));
            if (t.due_hint) bits.push('回收提示：' + esc(t.due_hint));
            return '<div class="item"><div class="it-h"><span class="it-t">' + esc(t.title || '（无题）') + '</span>'
              + '<span class="tag">' + esc(t.status || 'open') + '</span></div>'
              + (bits.length ? '<div class="it-b">' + bits.join('<br>') + '</div>' : '')
              + '<div class="it-actions"><button class="ghost" data-edit="' + t.id + '">编辑</button>'
              + '<button class="ghost" data-del="' + t.id + '">删除</button></div></div>';
          }).join('')
        : '<div class="empty-hero"><div class="eh-ic">🧵</div><div class="eh-t">还没有剧情线索</div>'
          + '<div class="eh-d">登记伏笔/走向与预计回收章节，避免长线吞坑。状态 open 代表未回收，resolved 代表已落子。</div>'
          + '<button class="primary eh-btn" id="addPlot">＋ 埋一条伏笔</button></div>';
      body.innerHTML = head + list;
      function form(t) {
        t = t || {};
        sheetForm(t.id ? '编辑剧情线索' : '新增剧情线索', [
          { key: 'title', label: '标题/事件', value: t.title || '' },
          { key: 'detail', label: '详情', type: 'textarea', value: t.detail || '' },
          { key: 'status', label: '状态', type: 'select', value: t.status || 'open', options: ['open', 'resolved'] },
          { key: 'due_hint', label: '回收提示', value: t.due_hint || '' }
        ], function (v) {
          return DB.saveThread(bookId, { title: v.title, detail: v.detail, status: v.status, due_hint: v.due_hint,
            planted_chapter_id: t.planted_chapter_id, payoff_chapter_id: t.payoff_chapter_id }, t.id)
            .then(function () { renderBookPlot(body, bookId); });
        });
      }
      on(q('#addPlot'), 'click', function () { form(null); });
      [].forEach.call(body.querySelectorAll('[data-edit]'), function (b) {
        on(b, 'click', function () { form(findRow(rows, b.getAttribute('data-edit'))); });
      });
      [].forEach.call(body.querySelectorAll('[data-del]'), function (b) {
        on(b, 'click', function () { delRow(function () { return DB.deleteThread(b.getAttribute('data-del')); }, function () { renderBookPlot(body, bookId); }, '线索'); });
      });
    });
  }

  // ---- 势力介绍 ----
  function renderBookFaction(body, bookId) {
    DB.listFactions(bookId).then(function (rows) {
      var head = '<div class="secrow"><span class="st">势力介绍（' + rows.length + '）</span>'
        + (rows.length ? '<button class="primary" id="addFac">＋ 新增</button>' : '') + '</div>';
      var list = rows.length ? rows.map(function (f) {
            return '<div class="item"><div class="it-h"><span class="it-t">' + esc(f.name || '（无名）') + '</span>'
              + (f.kind ? '<span class="tag">' + esc(f.kind) + '</span>' : '') + '</div>'
              + (f.intro ? '<div class="it-b">' + esc(clip(f.intro, 80)) + '</div>' : '')
              + '<div class="it-actions"><button class="ghost" data-edit="' + f.id + '">编辑</button>'
              + '<button class="ghost" data-del="' + f.id + '">删除</button></div></div>';
          }).join('')
        : '<div class="empty-hero"><div class="eh-ic">🏯</div><div class="eh-t">还没有势力</div>'
          + '<div class="eh-d">录入门派/国家/组织等阵营及其介绍，与人物卡、剧情线索共同构成世界观骨架。</div>'
          + '<button class="primary eh-btn" id="addFac">＋ 登记第一个势力</button></div>';
      body.innerHTML = head + list;
      function form(f) {
        f = f || {};
        sheetForm(f.id ? '编辑势力' : '新增势力', [
          { key: 'name', label: '势力名称', value: f.name || '' },
          { key: 'kind', label: '类型（门派/国家/组织…）', value: f.kind || '' },
          { key: 'intro', label: '介绍', type: 'textarea', rows: 4, value: f.intro || '' }
        ], function (v) {
          return DB.saveFaction(bookId, { name: v.name, kind: v.kind, intro: v.intro }, f.id)
            .then(function () { renderBookFaction(body, bookId); });
        });
      }
      on(q('#addFac'), 'click', function () { form(null); });
      [].forEach.call(body.querySelectorAll('[data-edit]'), function (b) {
        on(b, 'click', function () { form(findRow(rows, b.getAttribute('data-edit'))); });
      });
      [].forEach.call(body.querySelectorAll('[data-del]'), function (b) {
        on(b, 'click', function () { delRow(function () { return DB.deleteFaction(b.getAttribute('data-del')); }, function () { renderBookFaction(body, bookId); }, '势力'); });
      });
    });
  }


  /* ================= 编辑器（章正文 / 节正文 共用）F04–F07/F09/F11/F22/F32 ================= */
  // 章与节字段同形（title/body/summary/word_count），用 store 抽象切换读写目标，
  // 其余（全屏布局 / FAB 动作 / 打字防抖 / 预览采纳）单一实现复用。快照/回滚仅章级提供。
  function makeStore(mode, p) {
    if (mode === 'section') {
      var sectionId = p.sectionId, schapterId = p.chapterId;
      return {
        mode: 'section', docId: sectionId, titlePh: '节标题', label: '写作',
        load: function () { return DB.getSection(sectionId); },
        saveDraft: function (v) { return DB.saveSectionDraft(sectionId, v); },
        saveBody: function (v) { return DB.saveSectionBody(sectionId, v); },
        saveMeta: function (patch) { return DB.saveSectionMeta(sectionId, patch); },
        bookIdOf: function (doc) { return doc.book_id; },
        backHash: function () { return '#/chapter/' + schapterId; },
        hasVersion: false
      };
    }
    var bookId = p.bookId, chapterId = p.chapterId;
    return {
      mode: 'chapter', docId: chapterId, titlePh: '章节标题', label: '编辑',
      load: function () { return DB.getChapter(chapterId); },
      saveDraft: function (v) { return DB.saveChapterDraft(chapterId, v); },
      saveBody: function (v) { return DB.saveChapterBody(chapterId, v, 'adopt'); },
      saveMeta: function (patch) { return DB.saveChapterMeta(chapterId, patch); },
      bookIdOf: function () { return bookId; },
      backHash: function () { return '#/chapter/' + chapterId; },
      hasVersion: true
    };
  }

  function writer(mode, p) {
    var store = makeStore(mode, p);
    var U = root.NOVEL_UTIL;
    return store.load().then(function (ch) {
      if (!ch) { screen().innerHTML = head('编辑器') + '<div class="err">内容不存在或已被删除（F11）。请返回重进。</div>'; wireBack(); return; }
      var bookId = store.bookIdOf(ch);
      App().state.bookId = bookId; App().state.chapterId = store.mode === 'chapter' ? store.docId : ch.chapter_id;
      return Promise.all([ findBook(bookId), DB.listCharacters(bookId), DB.getSetting('api'), DB.getSetting('ai_context') ])
        .then(function (rs) {
        var book = rs[0], characters = rs[1], api = rs[2], ctx = rs[3];

        var html = head(store.label, store.backHash()) + '<div class="body editor">'
          // 顶栏（建议 3）：标题不再无限拉伸；字数·保存态·版本包成 .chbar-meta 元信息组，紧跟标题左对齐起排
          + '<div class="chbar"><input id="chTitle" class="tin" value="' + esc(ch.title || '') + '" placeholder="' + store.titlePh + '">'
          + '<div class="chbar-meta"><span class="wc" id="wc">' + (ch.word_count || 0) + ' 字</span>'
          + '<span class="mdot">·</span>'
          + '<span class="save" id="saveTag">已保存</span>'
          + (store.hasVersion ? '<button id="verBtn" class="verbtn">版本</button>' : '') + '</div></div>'
          + '<textarea id="body" class="ta" placeholder="在这里写正文，选中一段再点右下角 ✦ AI 动作…">' + esc(ch.body || '') + '</textarea>'
          + '<div class="fab-wrap" id="fabWrap">'
          + '<div class="fab-menu" id="fabMenu">'
          + '<button class="fab-item tool" data-act="locate">定位</button>'
          + '<button class="fab-item tool" data-act="all">选中全文</button>'
          + BUILTIN.filter(function (b) { return b.kind !== 'dialogue'; }).map(function (b) { return '<button class="fab-item" data-kind="' + b.kind + '">' + b.name + '</button>'; }).join('')
          + '<button class="fab-item tool" data-act="query">AI查找</button>'
          + '<button class="fab-item" id="moreAct">⋯ 更多</button>'
          + '</div>'
          + '<button class="fab-main" id="fabBtn">AI</button></div>'
          + '<div class="preview" id="pv" hidden>'
          + '<div class="pvhead"><span id="pvTitle">AI 结果</span><span class="sp"></span>'
          + '<span id="pvMeta" class="meta"></span></div>'
          + '<div class="pvbody" id="pvBody"></div>'
          + '<div class="pvfoot" id="pvFoot"></div></div>'
          + '</div>'
          + '<div class="sheet" id="sheet" hidden><div class="mask" data-closesheet></div><div class="panel" id="sheetPanel"></div></div>';
        screen().innerHTML = html;
        wireBack();

        var ta = q('#body'), wcEl = q('#wc'), saveTag = q('#saveTag');
        var pv = q('#pv'), pvBody = q('#pvBody'), pvFoot = q('#pvFoot'), pvMeta = q('#pvMeta'), pvTitle = q('#pvTitle');

        // ---- 打字自动保存（F53/F54）：交给 NOVEL_DRAFT_GUARD，单一实现 = 防抖 + 单飞 + 失败保脏重试 + 在途续存 ----
        var guard = root.NOVEL_DRAFT_GUARD.create({
          save: function (v) { return store.saveDraft(v); },
          debounce: 800,
          onState: function (st) {
            if (st.saving) saveTag.textContent = '保存中…';
            else if (st.saved) { wcEl.textContent = st.words + ' 字'; saveTag.textContent = '已保存'; }
            else if (st.error) { saveTag.textContent = '未保存'; App().toast('保存失败：' + (st.error.message || st.error), 'bad'); }
            else if (st.dirty) saveTag.textContent = '未保存…';
          }
        });
        function commit() { guard.flushNow(); }   // runAction 前把手改落盘（草稿，不快照）
        App().state.flush = function () { return guard.flushNow(); };   // 路由切换/切后台/返回键前强制落盘
        on(ta, 'input', function () { var cv = U.stripMarkers(ta.value); wcEl.textContent = DB.countWords(cv) + ' 字'; guard.mark(cv); });

        // ---- 标题保存 ----
        var titleDeb = root.NOVEL_UTIL.debounce(function () { store.saveMeta({ title: q('#chTitle').value }); }, 700);
        on(q('#chTitle'), 'input', titleDeb);

        // ---- 预览关闭（并清除定位标记，还原干净正文）----
        function closePreview() {
          pv.hidden = true; pvBody.textContent = ''; pvFoot.innerHTML = ''; pvMeta.textContent = '';
          var cleaned = U.stripMarkers(ta.value);
          if (cleaned !== ta.value) ta.value = cleaned;   // 采纳/放弃/关闭后标记不残留（程序赋值不触发 input，不弄脏守卫）
        }

        // ---- 选区（F11 越界兜底：以当前 textarea 值为准钳制）----
        //   与“定位”完全等效：先剥离任何 ⟦⟧ 标记取干净正文（stripMarkers），原生光标坐标经 mapToClean
        //   映射到干净坐标；保证即便正文残留（不成对）标记也不会把标记符发给 AI、坐标也不会错位。
        function currentSel() {
          var raw = ta.value;
          var clean = U.stripMarkers(raw);
          var mc = U.mapToClean(raw, ta.selectionStart, ta.selectionEnd);
          var s = mc.start, e = mc.end;
          if (s === e) {   // 未选：扩到光标所在段落（基于干净正文）
            var a = clean.lastIndexOf('\n', s - 1) + 1;
            var b = clean.indexOf('\n', e); b = b < 0 ? clean.length : b;
            if (a === b) { a = s; b = e; }
            return U.clampRange(a, b, clean.length);
          }
          return U.clampRange(s, e, clean.length);
        }

        // ---- 运行一个动作（userHint：本次操作的临时补充要求，可选；拼进 [指令] 且随选段/指令永不裁）----
        var running = null;
        function runAction(tpl, userHint) {
          if (running) { App().toast('上一条还在进行…'); return; }
          // 未配置真实模型/Key：拦截提示（不再静默走 mock 回显）
          var rd = App().apiReady(api);
          if (!rd.ok) { App().toast(rd.why, 'warn'); return; }
          // 目标区间：优先“定位”标记的选区（extractMarked 返回去标记 base 与 base 内偏移），否则用原生选区
          var raw = ta.value;
          var marked = U.extractMarked(raw);
          var v, sel;
          if (marked) { v = marked.base; sel = { start: marked.start, end: marked.end, valid: marked.end > marked.start }; }
          else { v = U.stripMarkers(raw); sel = currentSel(); }   // 去标记后与定位分支同基（v 与 currentSel 内部 clean 同源）
          var exempt = tpl.kind === 'continue' || tpl.kind === 'consistency' || tpl.kind === 'query';
          if (!sel.valid && !exempt) { App().toast('请先点『定位』或『选中全文』标出要处理的文字', 'warn'); return; }
          commit(); // 先把手改落盘（草稿，不快照；save 前已 stripMarkers）

          pv.hidden = false; pvBody.textContent = '';
          pvTitle.textContent = tpl.name + ' · 生成中…'; pvFoot.innerHTML = '<button class="ghost" data-stop>■ 停止</button>';
          pvMeta.textContent = '';
          var t0 = Date.now();

          var args = {
            book: book || { id: bookId }, chapter: ch, characters: characters, settings: ctx,
            api: api, template: tpl,
            userHint: String(userHint || '').slice(0, 500),
            selection: { start: sel.start, end: sel.end, text: v.slice(sel.start, sel.end) },
            before: v.slice(0, sel.start), after: v.slice(sel.end),
            onDelta: function (txt, full) { pvBody.textContent = full; ta.scrollTop = ta.scrollHeight; }
          };
          running = true;
          var useConsistency = tpl.kind === 'consistency';
          var call = useConsistency ? root.NOVEL_SESSION.runConsistency(App().deps(), args)
                                    : root.NOVEL_SESSION.executeAction(App().deps(), args);
          // 停止：中断流式，已生成部分仍会进入下方 then 分支（res.stopped）供采纳
          var stopBtn = q('#pvFoot [data-stop]');
          on(stopBtn, 'click', function () { if (call && call.cancel) { call.cancel(); if (stopBtn) stopBtn.disabled = true, stopBtn.textContent = '停止中…'; } });
          Promise.resolve(call).then(function (res) {
            running = null;
            if (!res || !res.ok) {
              pvTitle.textContent = tpl.name + ' · 失败';
              pvBody.textContent = '';
              pvFoot.innerHTML = '<button data-retry>重试</button><button data-close>关闭</button>';
              pvMeta.textContent = (res && res.reason) || '未知错误';
              q('#pvFoot [data-close]') && on(q('#pvFoot [data-close]'), 'click', closePreview);
              on(q('#pvFoot [data-retry]'), 'click', function () { runAction(tpl, userHint); });
              return;
            }
            if (useConsistency) return showConsistency(res);
            pvTitle.textContent = tpl.name + ' · ' + (res.stopped ? '已停止（采纳已生成部分？）' : '完成')
              + '（' + (((Date.now() - t0) / 1000).toFixed(1)) + 's）';
            pvBody.textContent = res.cleaned;
            if (!res.cleaned) { pvFoot.innerHTML = '<button data-close>关闭</button>'; on(q('#pvFoot [data-close]'), 'click', closePreview); return; }
            var meta = res.meta || {};
            pvMeta.textContent = (meta.estTokens ? '~' + meta.estTokens + ' tok' : '')
              + (meta.dropped && meta.dropped.length ? ' · 已裁剪' + meta.dropped.length + '段' : '')
              + (meta.matchedCharacters && meta.matchedCharacters.length ? ' · 命中' + meta.matchedCharacters.map(function (c) { return c.name; }).join('/') : '');
            renderAdoptBar(res, sel);
          }, function (e) {
            running = null; pvTitle.textContent = tpl.name + ' · 异常';
            pvBody.textContent = ''; pvMeta.textContent = e && e.message || e;
            pvFoot.innerHTML = '<button data-retry>重试</button><button data-close>关闭</button>';
            on(q('#pvFoot [data-close]'), 'click', closePreview);
            on(q('#pvFoot [data-retry]'), 'click', function () { runAction(tpl, userHint); });
          });
        }

        // ---- 动作发起前的“补充要求（可选）”小弹层（建议 7）：留空则与现状一致 ----
        var HINT_PH = {
          polish: '例如：更凝练 / 更有画面感 / 少用形容词',
          expand: '例如：补心理与环境细节 / 加一段动作戏',
          condense: '例如：只保留对话与关键动作',
          dialogue: '例如：让对白更锋利、带潜台词',
          continue: '例如：不要太狗血 / 埋一个伏笔',
          consistency: '例如：重点检查时间线与称呼'
        };
        function askHintThenRun(tpl) {
          if (!tpl) return;
          var panel = openSheet('hintSheet', '<div class="sh-title">' + esc(tpl.name) + ' · 补充要求（可选）</div>'
            + '<textarea id="hintTa" rows="3" maxlength="500" placeholder="' + esc(HINT_PH[tpl.kind] || '例如：更口语化 / 补充环境细节') + '"></textarea>'
            + '<div class="hint">会追加到指令后随本次请求发出（≤500 字，超预算也不会被裁剪）；留空按内置指令执行。</div>'
            + '<div class="row"><button class="primary" data-hintgo>开始</button><button class="ghost" data-closesheet>取消</button></div>');
          on(panel.querySelector('[data-hintgo]'), 'click', function () {
            var h = String(panel.querySelector('#hintTa').value || '').trim().slice(0, 500);
            closeSheet('hintSheet');
            runAction(tpl, h);
          });
        }

        // ---- 采纳栏（F07 三选：替换/插入/放弃）----
        function renderAdoptBar(res, sel) {
          pvFoot.innerHTML = root.NOVEL_ADOPT.MODES.map(function (m) {
            return '<button data-mode="' + m.key + '" class="' + (m.key === 'discard' ? 'ghost' : 'adopt') + '">' + m.label + '</button>';
          }).join('');
          [].forEach.call(pvFoot.querySelectorAll('[data-mode]'), function (btn) {
            on(btn, 'click', function () {
              var mode = btn.getAttribute('data-mode');
              // 以“当前”去标记正文重算选区（sel 为 base 坐标），避免生成期间用户又改了正文；标记不入库
              var cur = U.stripMarkers(ta.value);
              var c = root.NOVEL_UTIL.clampRange(sel.start, sel.end, cur.length);
              // 把选区原文一并交给采纳器：replace 时可剥掉模型偶发回显的重复原文，真正做到“覆盖”而非“新增一行”
              var ap = root.NOVEL_ADOPT.applyResult(mode, cur, c.start, c.end, res.cleaned, { selection: cur.slice(c.start, c.end) });
              if (ap.changed) {
                ta.value = ap.newBody;
                ta.selectionStart = ta.selectionEnd = ap.caret;
                // 采纳走 store.saveBody：章级覆盖旧正文→自动快照（F09 可回滚）；节级只存最新正文
                store.saveBody(ap.newBody).then(function (n) {
                  ch.body = ap.newBody; wcEl.textContent = n + ' 字'; saveTag.textContent = '已保存';
                  App().toast('已采纳并存档', 'ok');
                });
              } else { App().toast('正文未改动', 'warn'); }
              closePreview();
            });
          });
        }

        // ---- 一致性报告弹层（F32）----
        function showConsistency(res) {
          var items = res.issues || [];
          pvTitle.textContent = '一致性检查 · ' + items.length + ' 条';
          pvMeta.textContent = '';
          if (!items.length) { pvBody.innerHTML = '<p class="muted">未发现问题。</p>'; }
          else {
            pvBody.innerHTML = '<ul class="issues">' + items.map(function (it, i) {
              return '<li><div class="iq">「' + esc(it.quote) + '」</div>'
                + '<div class="ip"><b>' + esc(it.type || '问题') + '</b>：' + esc(it.problem) + '</div>'
                + (it.suggestion ? '<div class="is">建议：' + esc(it.suggestion) + '</div>' : '')
                + (it.quote ? '<button class="loc" data-loc="' + i + '">定位</button>' : '') + '</li>';
            }).join('') + '</ul>';
            [].forEach.call(pvBody.querySelectorAll('[data-loc]'), function (b) {
              on(b, 'click', function () {
                var it = items[+b.getAttribute('data-loc')];
                var idx = ta.value.indexOf(it.quote);
                if (idx >= 0) { ta.focus(); ta.setSelectionRange(idx, idx + it.quote.length); ta.scrollTop = Math.max(0, idx * 0.6); App().toast('已定位到正文', 'ok'); }
                else App().toast('正文中未找到该片段', 'warn');
              });
            });
          }
          pvFoot.innerHTML = '<button data-close>关闭</button>';
          on(q('#pvFoot [data-close]'), 'click', closePreview);
        }

        // ---- 定位：用罕见标记符包住要处理的选区（不改动正文本身，标记不入库）----
        function doLocate(selectAll) {
          var raw = ta.value;
          var clean = U.stripMarkers(raw);
          var s, e;
          if (selectAll) { s = 0; e = clean.length; }
          else {
            var mc = U.mapToClean(raw, ta.selectionStart, ta.selectionEnd);
            s = mc.start; e = mc.end;
          }
          if (s === e) { App().toast(selectAll ? '正文为空，无内容可定位' : '请先长按选中要定位的文字', 'warn'); return; }
          var nv = U.markSelection(clean, s, e);
          ta.value = nv;
          ta.selectionStart = ta.selectionEnd = nv.length;   // 光标移尾，避免残留选区
          App().toast('已定位 ' + U.extractMarked(nv).text.length + ' 字，可执行 AI 动作', 'ok');
        }

        // ---- AI查找：独立资料问答（与正文无关，不写回、不存对话）----
        function openQuery() {
          var panel = q('#sheetPanel');
          q('#sheet').hidden = false;
          panel.innerHTML = '<div class="sh-title">AI 查找（资料问答，不改动正文）</div>'
            + '<textarea id="qText" class="qta" rows="4" placeholder="想查什么？例如：唐代科举流程、某种枪械的有效射程…"></textarea>'
            + '<div class="fld"><label>补充要求（可选）</label><textarea id="qHint" rows="2" maxlength="500" placeholder="例如：按时间线分点、附出处常识、给写作建议"></textarea></div>'
            + '<div class="row"><button class="ghost" data-closesheet>取消</button><button class="primary" id="askGo">提问</button></div>';
          [].forEach.call(q('#sheet').querySelectorAll('[data-closesheet]'), function (x) {
            on(x, 'click', function () { q('#sheet').hidden = true; });
          });
          on(q('#askGo'), 'click', function () {
            var qq = q('#qText').value.trim();
            if (!qq) { App().toast('请输入要查找的问题', 'warn'); return; }
            var qh = String(q('#qHint').value || '').trim().slice(0, 500);
            q('#sheet').hidden = true;
            runQuery(qq, qh);
          });
        }
        function runQuery(question, userHint) {
          var rd = App().apiReady(api);   // 同样受配置门禁
          if (!rd.ok) { App().toast(rd.why, 'warn'); return; }
          if (running) { App().toast('上一条还在进行…'); return; }
          // 检索式模板（建议 7）：明确要求围绕主题详细展开、可分点、附背景与关键事实；仍只答不写回
          var tpl = { kind: 'query', name: 'AI查找',
            instruction: '请围绕以下主题进行检索并给出尽可能详细的说明：可分点列出，附背景、关键事实与容易写错的细节；' +
              '只回答查询主题本身，不要改写或续写任何正文。' };
          pv.hidden = false; pvBody.textContent = ''; pvMeta.textContent = '';
          pvTitle.textContent = 'AI查找 · 查询中…'; pvFoot.innerHTML = '<button class="ghost" data-stop>■ 停止</button>';
          var t0 = Date.now();
          var qSettings = { use_summary: false, inject_prev_summary: false, inject_taboos: false, token_budget: (ctx && ctx.token_budget) || 6000, prev_paras: 0, next_paras: 0 };
          var args = {
            book: { id: bookId }, chapter: ch, characters: [], settings: qSettings, api: api, template: tpl,
            userHint: String(userHint || '').slice(0, 500),
            selection: { start: 0, end: 0, text: question }, before: '', after: '',
            onDelta: function (txt, full) { pvBody.textContent = full; }
          };
          running = true;
          var call = root.NOVEL_SESSION.executeAction(App().deps(), args);
          var stopBtn = q('#pvFoot [data-stop]');
          on(stopBtn, 'click', function () { if (call && call.cancel) { call.cancel(); if (stopBtn) stopBtn.disabled = true, stopBtn.textContent = '停止中…'; } });
          Promise.resolve(call).then(function (res) {
            running = null;
            if (!res || !res.ok) {
              pvTitle.textContent = 'AI查找 · 失败'; pvBody.textContent = ''; pvMeta.textContent = (res && res.reason) || '未知错误';
              pvFoot.innerHTML = '<button data-retry>重试</button><button data-close>关闭</button>';
              on(q('#pvFoot [data-retry]'), 'click', function () { runQuery(question, userHint); });
              on(q('#pvFoot [data-close]'), 'click', closePreview);
              return;
            }
            pvTitle.textContent = 'AI查找 · 完成（' + (((Date.now() - t0) / 1000).toFixed(1)) + 's）';
            pvBody.textContent = res.cleaned || '（无返回内容）';
            pvFoot.innerHTML = '<button data-copy>复制</button><button class="ghost" data-close>关闭</button>';
            on(q('#pvFoot [data-copy]'), 'click', function () { copyText(res.cleaned); });
            on(q('#pvFoot [data-close]'), 'click', closePreview);
          }, function (e) {
            running = null; pvTitle.textContent = 'AI查找 · 异常'; pvBody.textContent = ''; pvMeta.textContent = (e && e.message) || e;
            pvFoot.innerHTML = '<button data-close>关闭</button>';
            on(q('#pvFoot [data-close]'), 'click', closePreview);
          });
        }

        // ---- FAB：主钮开合菜单，点子项即执行并收起；点正文自动收起 ----
        var fabWrap = q('#fabWrap');
        on(q('#fabBtn'), 'click', function (e) { e.stopPropagation(); fabWrap.classList.toggle('open'); });
        on(ta, 'click', function () { fabWrap.classList.remove('open'); });
        [].forEach.call(fabWrap.querySelectorAll('.fab-item[data-kind]'), function (b) {
          on(b, 'click', function () {
            fabWrap.classList.remove('open');
            var kind = b.getAttribute('data-kind');
            askHintThenRun(BUILTIN.filter(function (x) { return x.kind === kind; })[0]);
          });
        });
        [].forEach.call(fabWrap.querySelectorAll('.fab-item[data-act]'), function (b) {
          on(b, 'click', function () {
            var act = b.getAttribute('data-act');
            fabWrap.classList.remove('open');
            if (act === 'locate') doLocate(false);
            else if (act === 'all') doLocate(true);
            else if (act === 'query') openQuery();
          });
        });
        on(q('#moreAct'), 'click', function () { fabWrap.classList.remove('open'); openMore(bookId); });
        App()._runAction = askHintThenRun;   // 供“更多”弹层（在编辑器闭包外）回调；同样先过补充要求弹层
        q('#pvFoot') && on(pv, 'click', function (e) { if (e.target.getAttribute && e.target.getAttribute('data-close') != null) closePreview(); });

        // ---- 版本/快照弹层（F09，仅章级）----
        if (store.hasVersion) on(q('#verBtn'), 'click', function () { openSnapshots(store.docId); });

        return openMore; // 供 sheet 用
      });
    });
  }
  function editor(p) { return writer('chapter', p); }
  function section(p) { return writer('section', p); }

  // 更多动作：内置全集 + 自定义模板 + 一致性检查
  function openMore(bookId) {
    return DB.listTemplates(bookId).then(function (customs) {
      var list = BUILTIN.concat([{ kind: 'consistency', name: '一致性检查', instruction: '检查人物设定、时间线与常识层面的矛盾，输出 JSON 报告。' }]);
      (customs || []).forEach(function (t) { if (t && t.instruction) list.push({ kind: t.kind || 'custom', name: t.name, instruction: t.instruction }); });
      var panel = q('#sheetPanel');
      q('#sheet').hidden = false;
      panel.innerHTML = '<div class="sh-title">选择动作</div><ul class="list">'
        + list.map(function (b, i) { return '<li class="opt" data-i="' + i + '">' + esc(b.name) + '</li>'; }).join('')
        + '</ul><button class="ghost block" data-closesheet>取消</button>';
      var closers = function () {
        [].forEach.call(screen().querySelectorAll('[data-closesheet]'), function (x) {
          on(x, 'click', function () { q('#sheet').hidden = true; });
        });
      };
      closers();
      [].forEach.call(panel.querySelectorAll('[data-i]'), function (li) {
        on(li, 'click', function () {
          q('#sheet').hidden = true;
          root.NOVEL_VIEWS._pendingTpl = list[+li.getAttribute('data-i')];
          // 复用编辑器发起链路：先过“补充要求（可选）”，再执行（App._runAction 已接 askHintThenRun）
          if (App()._runAction) App()._runAction(root.NOVEL_VIEWS._pendingTpl);
        });
      });
    });
  }

  // 快照列表与回滚（F09）
  function openSnapshots(chapterId) {
    return DB.listSnapshots(chapterId).then(function (snaps) {
      var panel = q('#sheetPanel'); q('#sheet').hidden = false;
      panel.innerHTML = '<div class="sh-title">历史版本（采纳/回滚留痕）</div>'
        + (snaps.length ? '<ul class="list">' + snaps.map(function (s) {
            return '<li class="opt snap"><div>' + new Date(s.created_at).toLocaleString()
              + ' · ' + (s.word_count || 0) + ' 字 <span class="tag">' + esc(s.reason) + '</span></div>'
              + '<button data-rollback="' + s.id + '">回滚到此</button></li>';
          }).join('') + '</ul>' : '<p class="muted">暂无快照。采纳 AI 结果或回滚时会自动留痕。</p>')
        + '<button class="ghost block" data-closesheet>关闭</button>';
      [].forEach.call(screen().querySelectorAll('[data-closesheet]'), function (x) {
        on(x, 'click', function () { q('#sheet').hidden = true; });
      });
      [].forEach.call(panel.querySelectorAll('[data-rollback]'), function (b) {
        on(b, 'click', function () {
          DB.rollback(b.getAttribute('data-rollback')).then(function (n) {
            App().toast('已回滚（当前版本也已留痕）', 'ok');
            App().state.flush = null;                 // 直接重进编辑器取最新正文
            App().go('#/editor/' + App().state.bookId + '/' + chapterId);
          }, function (e) { App().toast('回滚失败：' + (e.message || e), 'bad'); });
        });
      });
    });
  }

  /* ================= 作品信息（旧“作品设定”，现作为书内一个分段，渲染进 body 容器） F02 + 上下文开关 F20–F24 ================= */
  function renderBookInfo(body, book, bookId) {
    DB.getSetting('ai_context').then(function (ctx) {
      var bq = function (sel) { return body.querySelector(sel); };
      var sw = function (key, label, hint) {
        return '<label class="switch"><div><b>' + label + '</b><div class="hint">' + hint + '</div></div>'
          + '<input type="checkbox" data-ck="' + key + '"' + (ctx[key] ? ' checked' : '') + '></label>';
      };
      body.innerHTML = '<div class="secrow"><span class="st">作品信息</span></div><div class="form">'
        + '<div class="fld"><label>标题</label><input id="bkTitle" value="' + esc(book.title || '') + '"></div>'
        + '<div class="fld"><label>作者</label><input id="bkAuthor" value="' + esc(book.author || '') + '"></div>'
        + '<div class="fld"><label>简介 / 世界观</label><textarea id="bkSyn" rows="3">' + esc(book.synopsis || '') + '</textarea></div>'
        + '<div class="fld"><label>文风备注</label><input id="bkStyle" value="' + esc(book.style_note || '') + '"></div>'
        + '<h2 class="sec">上下文注入（F20–F24）</h2>'
        + sw('use_summary', '注入章节摘要', '把本章已有摘要带进提示词')
        + sw('inject_prev_summary', '注入前情摘要', '带上一章摘要做衔接')
        + sw('inject_taboos', '注入角色禁忌/口癖', '按命中角色卡补充设定')
        + '<div class="fld"><label>Token 预算</label><input id="bkBudget" type="number" value="' + (ctx.token_budget || 6000) + '"><div class="hint">超出按“作品设定→本章摘要→角色卡→前文→后文”五级裁剪，选段与指令永不裁</div></div>'
        + '<div class="row"><button class="primary" id="saveBk">保存</button>'
        + '<button id="dryRun">试运行(拼装提示词，不联网)</button></div>'
        + '<pre class="dryout" id="dryOut" hidden></pre></div>';
      on(bq('#saveBk'), 'click', function () {
        DB.updateBook(bookId, { title: bq('#bkTitle').value, author: bq('#bkAuthor').value, synopsis: bq('#bkSyn').value, style_note: bq('#bkStyle').value })
          .then(function () {
            var next = Object.assign({}, ctx, {
              use_summary: bq('[data-ck="use_summary"]').checked,
              inject_prev_summary: bq('[data-ck="inject_prev_summary"]').checked,
              inject_taboos: bq('[data-ck="inject_taboos"]').checked,
              token_budget: parseInt(bq('#bkBudget').value, 10) || 6000
            });
            next.auto_adopt = false;
            return DB.setSetting('ai_context', next);
          }).then(function () { App().toast('已保存信息', 'ok'); App().go('#/book/' + bookId + '/info'); },
                  function (e) { App().toast('保存失败：' + (e.message || e), 'bad'); });
      });
      on(bq('#dryRun'), 'click', function () {
        var out = bq('#dryOut'); out.hidden = false;
        DB.listChapters(bookId).then(function (chs) {
          if (!chs.length) { out.textContent = '（先建一个章节再试运行）'; return; }
          return DB.getChapter(chs[0].id).then(function (c) {
            var built = root.NOVEL_PROMPT.build({
              book: book, chapterSummary: c.summary, selection: '（示例选段：请替换为你真正要处理的文字）',
              beforeText: c.body.slice(0, 200), afterText: c.body.slice(-200), matchText: c.body,
              characters: [], template: BUILTIN[0], settings: ctx
            });
            out.textContent = '估算 ' + built.estTokens + ' tokens / ' + built.chars + ' 字；裁剪 ' + (built.dropped || []).length + ' 段\n\n' + built.prompt;
          });
        });
      });
    });
  }

  /* ================= 我的 F50：竖向页签（AI助手 / 存储 / 界面设置 / 导入书籍 / 数据与安全 / 问题反馈） ================= */
  var ME_TABS = [
    { key: 'ai', label: 'AI 助手' },
    { key: 'storage', label: '存储' },
    { key: 'appearance', label: '界面设置' },
    { key: 'import', label: '导入书籍' },
    { key: 'data', label: '数据与安全' },
    { key: 'feedback', label: '问题反馈' }
  ];
  // 反馈与说明（建议 8）：邮箱唯一常量，反馈页与用户说明弹层共用，避免两处口径不一
  var FEEDBACK_EMAIL = '3620522389@qq.com';
  var APP_VERSION = 'v3.22';

  // 用户说明弹层（常驻“我的”底部居中入口）：隐私免责 + 提交规则 + 版本版权
  function openUserDoc() {
    openSheet('userDoc', '<div class="sh-title">用户说明 · 隐私与免责</div><div class="doc">'
      + '<h3>隐私与数据安全</h3>'
      + '<p>· 本应用是纯本地写作工具，无需登录注册。</p>'
      + '<p>· 作品数据（书籍/章节/人物/设定等）只保存在手机本机应用私有目录，不上传任何服务器。</p>'
      + '<p>· API Key 经 Android Keystore（AES-GCM）加密保存，绝不明文进入数据库、备份包或日志。</p>'
      + '<p>· 备份包不含密钥；派生产物只落在私有目录 temp/ 内，可在“存储”页一键清理。</p>'
      + '<p>· 使用 AI 功能时，仅把拼装后的提示词（含选段与必要上下文）发送给您自行配置的服务商；未配置时不会发出任何网络请求。</p>'
      + '<h3>问题反馈与提交规则</h3>'
      + '<p>· 建议与 bug 请发送至 ' + FEEDBACK_EMAIL + '，请附上版本号与复现步骤。</p>'
      + '<p>· 邮箱为唯一反馈渠道，响应不作时效承诺；不接收与写作无关的商业信息。</p>'
      + '<h3>其他</h3>'
      + '<p>· AI 生成内容仅供参考，发布前请自行审校与合规检查。</p>'
      + '<div class="doc-foot">当前版本 ' + APP_VERSION + ' · © 2026 AI 写作助手</div></div>');
  }

  function me(p) {
    var tab = (p && p.tab) || 'ai';
    var navHtml = ME_TABS.map(function (t) {
      return '<button class="vbtn' + (t.key === tab ? ' active' : '') + '" data-me-nav="' + t.key + '">' + esc(t.label) + '</button>';
    }).join('');
    // 底部常驻居中“用户说明”入口（不属任何单页，点开 .sheet 弹层，不用原生弹窗）
    screen().innerHTML = head('我的', '')
      + '<div class="vwrap"><nav class="vnav">' + navHtml + '</nav><div class="vpanel" id="meBody"></div></div>'
      + '<div class="me-foot"><button id="userDocBtn">用户说明 · 隐私与免责</button></div>';
    screen().classList.add('screen--dual');   // 双栏左右独立滚动（§4-D）
    wireBack();
    on(q('#userDocBtn'), 'click', openUserDoc);
    [].forEach.call(screen().querySelectorAll('[data-me-nav]'), function (b) {
      on(b, 'click', function () { App().go('#/me/' + b.getAttribute('data-me-nav')); });
    });
    var body = q('#meBody');
    if (tab === 'storage') renderMeStorage(body);
    else if (tab === 'appearance') renderMeAppearance(body);
    else if (tab === 'import') renderMeImport(body);
    else if (tab === 'feedback') renderMeFeedback(body);
    else if (tab === 'data') renderMeData(body);
    else renderMeAi(body);
  }

  // 配置 AI 助手（模型接入）
  function renderMeAi(body) {
    Promise.all([
      DB.getSetting('api'),
      root.NOVEL_SECURE ? root.NOVEL_SECURE.hasSecret('api_key').catch(function () { return false; }) : Promise.resolve(false)
    ]).then(function (rs) {
      var api = rs[0] || {}, hasKey = rs[1];
      var PROV = (root.NOVEL_PROVIDERS && root.NOVEL_PROVIDERS.PRESETS) || {};
      // 友好名称列表；不再提供 mock（仅 Node 测试用）；默认落到“自定义”（fresh 安装 provider=mock 也归一到 custom）
      var provList = [['openai_chat', 'OpenAI 兼容'], ['deepseek', 'DeepSeek'], ['qwen', '通义千问 Qwen'], ['anthropic', 'Anthropic Claude'], ['custom', '自定义']];
      var known = provList.some(function (kv) { return kv[0] === api.provider; });
      var cur = known ? api.provider : 'custom';
      var opts = provList.map(function (kv) {
        return '<option value="' + kv[0] + '"' + (cur === kv[0] ? ' selected' : '') + '>' + kv[1] + '</option>';
      }).join('');
      // 初始 Base/Model：已存值优先，否则用预设默认（仍可改）
      var pr0 = PROV[cur] || {};
      var base0 = api.base_url || pr0.base || '';
      var MODEL_CUSTOM = '__custom__';
      body.innerHTML = '<div class="secrow"><span class="st">配置 AI 助手</span></div><div class="form">'
        + '<div class="fld"><label>Provider</label><select id="prov">' + opts + '</select><div class="hint" id="provHint"></div></div>'
        + '<div class="fld"><label>Base URL</label><input id="base" value="' + esc(base0) + '" placeholder="https://…"></div>'
        + '<div class="fld"><label>Model</label><select id="model"></select>'
        + '<input id="modelCustom" type="text" value="" placeholder="手动输入模型 ID" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="margin-top:6px" hidden>'
        + '<div class="hint" id="modelHint"></div></div>'
        + '<div class="fld"><label>API Key</label><input id="key" type="text" class="masked" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="' + (hasKey ? '已保存（留空不改）' : 'sk-…') + '">'
        + '<div class="hint">可粘贴输入，显示为圆点不可查看明文；密钥经 AES-GCM 加密落本地 Keystore/Preferences，绝不进主数据库、不明文外传（F50）</div></div>'
        + '<div class="row"><button class="primary" id="saveApi">保存接入</button></div>'
        + '<div class="note">' + (App().nativeAiStream() ? '未选择模型并保存 Key 时，写作页的 AI 功能会提示先配置' : '⚠ 本机未构建原生 AiStream 插件，即使配好 Key 也无法联网；可先检查配置项') + '</div>'
        + '</div>';

      // 选服务商→自动带入已知 Base URL 与模型清单（Model 下拉选，清单外可“手动输入…”）；自定义→无预设清单，一律手输
      function provLabel(k) { var f = provList.filter(function (kv) { return kv[0] === k; })[0]; return f ? f[1] : k; }
      function updateModelHint(k) {
        var sel = q('#model');
        q('#modelHint').textContent = sel.value === MODEL_CUSTOM
          ? '手动输入：填写服务商给出的模型 ID（如 gpt-4o、deepseek-v4-pro）'
          : '从 ' + provLabel(k || q('#prov').value) + ' 已知模型中选择；没有需要的可切“手动输入…”';
      }
      // 按服务商填充 Model 下拉；desired 命中清单则选中，否则（含自定义/已存旧值）落到“手动输入…”并回填
      function fillModels(k, desired) {
        var list = (PROV[k] && PROV[k].models) || [], sel = q('#model'), cust = q('#modelCustom');
        sel.innerHTML = list.map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join('')
          + '<option value="' + MODEL_CUSTOM + '">手动输入…</option>';
        desired = desired == null ? '' : String(desired);
        if (desired && list.indexOf(desired) >= 0) { sel.value = desired; cust.hidden = true; cust.value = ''; }
        else { sel.value = MODEL_CUSTOM; cust.value = desired; cust.hidden = false; }
        updateModelHint(k);
      }
      function modelValue() { var sel = q('#model'); return sel.value === MODEL_CUSTOM ? q('#modelCustom').value.trim() : sel.value; }
      function applyPreset(force) {
        var k = q('#prov').value, p = PROV[k] || {}, b = q('#base');
        if (k === 'custom') {
          if (force) b.value = '';
          q('#provHint').textContent = '自定义：填写服务商提供的 Base URL，并手动输入 Model';
          fillModels(k, force ? '' : (api.model || ''));
        } else {
          if (force || !b.value) b.value = p.base || '';
          q('#provHint').textContent = '已带入 ' + provLabel(k) + ' 默认地址，可修改';
          fillModels(k, force ? (p.model || '') : (api.model || p.model || ''));
        }
      }
      applyPreset(false);   // 初始：Base/Model 已存值优先，不覆盖
      on(q('#prov'), 'change', function () { applyPreset(true); });
      on(q('#model'), 'change', function () {
        var sel = q('#model'), cust = q('#modelCustom');
        if (sel.value === MODEL_CUSTOM) { cust.hidden = false; cust.focus(); } else { cust.hidden = true; cust.value = ''; }
        updateModelHint();
      });

      on(q('#saveApi'), 'click', function () {
        var next = { provider: q('#prov').value, base_url: q('#base').value.trim(), model: modelValue(), key_set: api.key_set };
        if (!next.base_url) { App().toast('请填写 Base URL', 'warn'); return; }
        if (!next.model) { App().toast('请选择或输入 Model', 'warn'); return; }
        var kv = q('#key').value.trim();
        var chain = Promise.resolve();
        if (kv && root.NOVEL_SECURE) chain = root.NOVEL_SECURE.setSecret('api_key', kv).then(function () { next.key_set = true; });
        chain.then(function () { return DB.setSetting('api', next); })
          .then(function () { App().toast('已保存接入配置', 'ok'); renderMeAi(body); },
                function (e) { App().toast('保存失败：' + ((e && e.message) || e), 'bad'); });
      });
    });
  }

  // 配置存储（基础路径只读展示 + 保留策略 + 统计 + 清理）
  function renderMeStorage(body) {
    DB.getSetting('storage').then(function (stg) {
      stg = stg || {};
      var rep = App().state.report || {}; var temp = rep.temp || {};
      var rootName = temp.root || stg.temp_root || 'temp';
      body.innerHTML = '<div class="secrow"><span class="st">配置存储</span></div><div class="form">'
        + '<div class="fld"><label>数据根目录</label><input value="应用私有目录 / ' + esc(rootName) + '" readonly>'
        + '<div class="hint">主数据（SQLite）与派生数据（' + esc(rootName) + '/）物理隔离；路径由系统沙箱固定，不可改到公共目录以防泄漏。</div></div>'
        + '<label class="switch"><div><b>自动清理过期暂存</b></div><input type="checkbox" id="stAuto"' + (stg.temp_auto_clean ? ' checked' : '') + '></label>'
        + '<div class="fld"><label>暂存保留天数</label><input id="stKeep" type="number" value="' + (stg.temp_keep_days || 7) + '"></div>'
        + '<div class="row"><button class="primary" id="saveSt">保存</button><button id="clearTemp">清理临时缓存</button></div>'
        + '<h2 class="sec">存储统计</h2><div class="row"><button id="statBtn">统计一次</button></div>'
        + '<pre class="probe" id="statOut" hidden></pre>'
        + '<h2 class="sec">回收站</h2><div id="trashBox">加载中…</div>'
        + '</div>';
      renderTrash(q('#trashBox'));
      on(q('#saveSt'), 'click', function () {
        var next = Object.assign({}, stg, { temp_auto_clean: q('#stAuto').checked, temp_keep_days: parseInt(q('#stKeep').value, 10) || 7 });
        DB.setSetting('storage', next).then(function () { App().toast('已保存存储设置', 'ok'); renderTrash(q('#trashBox')); },
          function (e) { App().toast('保存失败：' + ((e && e.message) || e), 'bad'); });
      });
      on(q('#clearTemp'), 'click', function () {
        if (root.NOVEL_TEMP && root.NOVEL_TEMP.clearAll) root.NOVEL_TEMP.clearAll().then(function () { App().toast('已清理临时缓存', 'ok'); }, function (e) { App().toast('清理失败：' + ((e && e.message) || e), 'bad'); });
        else App().toast('暂存层不可用', 'warn');
      });
      on(q('#statBtn'), 'click', function () {
        if (!needTemp()) return;
        var out = q('#statOut'); out.hidden = false; out.textContent = '统计中…';
        DA().storageReport(dataDeps(), {}).then(function (s) {
          var t = s.tables || {};
          out.textContent = '作品 ' + (s.totals.books || 0) + ' · 章节 ' + (s.totals.chapters || 0)
            + ' · 字数 ' + (s.totals.words || 0) + ' · 角色 ' + (s.totals.characters || 0)
            + '\nAI 作业：共 ' + s.ai.total + '（失败 ' + s.ai.failed + '）'
            + '\n库体积：' + Math.round(s.database.bytes / 1024) + ' KB（' + s.database.pages + '×' + s.database.pageSize + 'B）'
            + (s.temp ? '\ntemp 占用：' + s.temp.total.files + ' 文件 / ' + Math.round(s.temp.total.bytes / 1024) + ' KB' : '\ntemp：未就绪')
            + '\n各表行数：' + Object.keys(t).map(function (k) { return k + '=' + t[k]; }).join('  ');
        }, function (e) { out.hidden = false; out.textContent = '统计失败：' + (e.message || e); });
      });
    });
  }

  // 回收站分区：列表 + 逐条恢复/彻底删除 + 清空（均走页内 confirmSheet，禁原生弹窗）
  function renderTrash(container) {
    if (!container) return;
    DB.getSetting('storage').catch(function () { return null; }).then(function (stg) {
      var days = (stg && stg.temp_keep_days) || 7;
      return DB.listTrash().then(function (tr) {
        var DAY = 86400000, nowMs = Date.now();
        var rows = [];
        tr.books.forEach(function (b) { rows.push({ kind: 'book', id: b.id, label: '作品', title: b.title, at: b.deleted_at }); });
        tr.chapters.forEach(function (c) { rows.push({ kind: 'chapter', id: c.id, label: '章节', title: c.title, at: c.deleted_at, extra: (c.word_count || 0) + ' 字' }); });
        tr.sections.forEach(function (s) { rows.push({ kind: 'section', id: s.id, label: '节', title: s.title, at: s.deleted_at }); });
        rows.sort(function (a, b) { return b.at - a.at; });
        if (!rows.length) { container.innerHTML = '<p class="muted">回收站是空的。删除的作品/章节/节会先移到这里，保留 ' + days + ' 天可恢复。</p>'; return; }
        container.innerHTML = '<div class="hint">以下条目在回收站保留 ' + days + ' 天，到期后若已开启“自动清理过期暂存”会于下次启动/回前台自动彻底清除。</div>'
          + '<ul class="list">' + rows.map(function (r) {
              var remain = Math.max(0, Math.ceil((r.at + days * DAY - nowMs) / DAY));
              return '<li class="card trash-item">'
                + '<div class="ct">[' + r.label + '] ' + esc(r.title || '未命名') + '</div>'
                + '<div class="cs">' + (r.extra ? r.extra + ' · ' : '') + '约 ' + remain + ' 天后到点清除</div>'
                + '<div class="card-foot row">'
                + '<button class="primary" data-restore data-kind="' + r.kind + '" data-id="' + r.id + '">恢复</button>'
                + '<button class="btn-del" data-purge data-kind="' + r.kind + '" data-id="' + r.id + '" data-title="' + esc(r.title || '未命名') + '">彻底删除</button>'
                + '</div></li>';
            }).join('') + '</ul>'
          + '<div class="row"><button id="emptyTrashBtn" class="btn-del">清空回收站</button></div>';
        [].forEach.call(container.querySelectorAll('[data-restore]'), function (btn) {
          on(btn, 'click', function () {
            var k = TRASH_KINDS[btn.getAttribute('data-kind')];
            Promise.resolve(DB[k.restore](Number(btn.getAttribute('data-id')))).then(function () {
              App().toast('已恢复', 'ok'); renderTrash(container);
            }, function (e) { App().toast('恢复失败：' + ((e && e.message) || e), 'bad'); });
          });
        });
        [].forEach.call(container.querySelectorAll('[data-purge]'), function (btn) {
          on(btn, 'click', function () {
            var kind = btn.getAttribute('data-kind'), id = Number(btn.getAttribute('data-id'));
            confirmSheet('彻底删除', '「' + (btn.getAttribute('data-title') || '未命名') + '」将被永久清除，不可恢复。确定？', function () {
              Promise.resolve(DB.purgeOne(kind, id)).then(function () { App().toast('已彻底删除', 'ok'); renderTrash(container); },
                function (e) { App().toast('删除失败：' + ((e && e.message) || e), 'bad'); });
            });
          });
        });
        on(container.querySelector('#emptyTrashBtn'), 'click', function () {
          confirmSheet('清空回收站', '将永久清除回收站内全部 ' + rows.length + ' 条内容，不可恢复。确定？', function () {
            Promise.resolve(DB.emptyTrash()).then(function () { App().toast('已清空回收站', 'ok'); renderTrash(container); },
              function (e) { App().toast('清空失败：' + ((e && e.message) || e), 'bad'); });
          });
        });
      });
    });
  }

  // 界面设置（主题/字号/行距/首行缩进/内容宽度）
  function renderMeAppearance(body) {
    DB.getSetting('appearance').then(function (a) {
      a = a || {};
      var themeName = { paper: '纸色', light: '浅色', dark: '深色' };
      var themeSel = ['paper', 'light', 'dark'].map(function (k) {
        return '<option value="' + k + '"' + ((a.theme || 'paper') === k ? ' selected' : '') + '>' + themeName[k] + '</option>';
      }).join('');
      body.innerHTML = '<div class="secrow"><span class="st">界面设置</span></div><div class="form">'
        + '<div class="fld"><label>主题</label><select id="apTheme">' + themeSel + '</select></div>'
        + '<div class="fld"><label>字号（px）</label><input id="apFont" type="number" value="' + (a.font_size || 17) + '"></div>'
        + '<div class="fld"><label>行间距（倍数）</label><input id="apLine" type="number" step="0.1" value="' + (a.line_height || 1.9) + '"></div>'
        + '<div class="fld"><label>内容宽度（px）</label><input id="apWidth" type="number" value="' + (a.content_width || 720) + '"></div>'
        + '<label class="switch"><div><b>首行缩进两字</b><div class="hint">作用于预览/成文渲染（编辑框为纯文本 textarea，不生效）</div></div><input type="checkbox" id="apIndent"' + (a.para_indent ? ' checked' : '') + '></label>'
        + '<div class="row"><button class="primary" id="saveAp">保存并应用</button></div>'
        + '<div class="note">改主题/字号会即时预览整个界面；保存后全局长期生效。</div>'
        + '</div>';
      function grab() {
        return { theme: q('#apTheme').value, font_size: parseInt(q('#apFont').value, 10) || 17,
          line_height: parseFloat(q('#apLine').value) || 1.9, content_width: parseInt(q('#apWidth').value, 10) || 720,
          para_indent: q('#apIndent').checked };
      }
      function preview() { App().applyAppearance(grab()); }
      ['apTheme', 'apFont', 'apLine', 'apWidth', 'apIndent'].forEach(function (id) { var e = q('#' + id); on(e, 'change', preview); on(e, 'input', preview); });
      on(q('#saveAp'), 'click', function () {
        var t = grab();
        DB.setSetting('appearance', t).then(function () { App().applyAppearance(t); App().toast('已保存界面设置', 'ok'); },
          function (e) { App().toast('保存失败：' + ((e && e.message) || e), 'bad'); });
      });
    });
  }

  // 数据与安全（备份/恢复/运行自检）——导入已拆到独立“导入书籍”页签（建议 5），本页不再放导入表单
  function renderMeData(body) {
    var rep = App().state.report || {};
    body.innerHTML = '<div class="sec-head"><span class="st">数据与安全</span></div><div class="form">'
      + '<div class="row"><button id="backupBtn">立即备份</button><button id="restoreBtn">恢复最近备份</button></div>'
      + '<div class="note">备份/恢复只作用于本地库；产物落私有目录 temp/backup/，密钥绝不入包。写 Downloads/分享需原生层，待接。</div>'
      + '<h2 class="sec">运行自检</h2><pre class="probe">' + esc(
          '数据层: ' + (rep.ready ? 'ok v' + (rep.dbInfo && rep.dbInfo.toVersion) : '未就绪')
        + ' | 加密: ' + (rep.secure && rep.secure.status)
        + ' | 暂存: ' + (rep.temp && rep.temp.status)
        + ' | 插件: ' + (rep.plugins || []).join(',')) + '</pre>'
      + '</div>';
    on(q('#backupBtn'), 'click', function () {
      if (!needTemp()) return;
      App().toast('备份中…');
      DA().backupNow(dataDeps(), {}).then(function (r) {
        App().toast('已备份 ' + Math.round(r.bytes / 1024) + ' KB → temp/backup/' + r.name, 'ok');
      }, function (e) { App().toast('备份失败：' + (e.message || e), 'bad'); });
    });
    on(q('#restoreBtn'), 'click', function () {
      if (!needTemp()) return;
      DA().listBackups(dataDeps()).then(function (list) {
        if (!list.length) { App().toast('temp/backup 里没有备份包', 'warn'); return; }
        var newest = list[0];
        confirmSheet('恢复备份', '将用“' + newest.name + '”整体覆盖当前库（恢复前会自动先备份当前数据）。确定？', function () {
          App().toast('恢复中…');
          DA().restoreFrom(dataDeps(), { name: newest.name }).then(function (res) {
            if (res.ok) { App().toast('已恢复（共 ' + res.restored + ' 条语句，已先做 safety 快照）', 'ok'); App().go('#/shelf'); }
            else App().toast('未恢复：' + (res.reason || '') + (res.error ? ' · ' + res.error : ''), 'bad');
          }, function (e) { App().toast('恢复失败：' + (e.message || e), 'bad'); });
        });
      });
    });
  }

  /* ================= 导入书籍（规划书 v2：三种录入格式 + txt 文件导入） =================
     录入格式：章节分开 split（默认，建/并入书，章>节两层）/ 单章 chapterOnly（只切章，
     节行降级并入章正文）/ 单节 sectionOnly（只切节，并入指定的一章）。文本来源：粘贴框或
     txt 文件（UTF-8 优先，乱码回退 GB18030）。落库前预检二次确认；并入只追加，绝不改既有内容。 */
  function renderMeImport(body) {
    DB.listBooks().then(function (books) {
      var canMerge = books.length > 0;
      var curBookId = App().state.bookId ? String(App().state.bookId) : '';
      body.innerHTML = '<div class="sec-head"><span class="st">导入书籍</span></div><div class="form">'
        + '<div class="fld" id="fldMode"><label>导入到</label><div class="radiogroup">'
        + '<label class="radio"><input type="radio" name="impMode" value="new" checked> 新建书籍</label>'
        + '<label class="radio"><input type="radio" name="impMode" value="merge"' + (canMerge ? '' : ' disabled') + '> 并入现有书籍</label>'
        + '</div>' + (canMerge ? '' : '<div class="hint">还没有任何书籍，“并入”需先新建一本。</div>') + '</div>'
        + '<div class="fld"><label>录入格式</label><div class="radiogroup">'
        + '<label class="radio"><input type="radio" name="impFmt" value="split" checked> 章节分开录入</label>'
        + '<label class="radio"><input type="radio" name="impFmt" value="chapterOnly"> 单章录入</label>'
        + '<label class="radio"><input type="radio" name="impFmt" value="sectionOnly"> 单节录入</label>'
        + '</div><div class="hint" id="fmtHint"></div></div>'
        + '<div class="fld" id="fldTitle"><label>书名</label><input id="impTitle" placeholder="导入的作品标题"></div>'
        + '<div class="fld" id="fldBook" hidden><label>目标书籍</label><select id="impBook">'
        + books.map(function (b) {
            return '<option value="' + b.id + '"' + (String(b.id) === curBookId ? ' selected' : '') + '>' + esc(b.title || '未命名') + '</option>';
          }).join('') + '</select><div class="hint" id="bookStat"></div></div>'
        + '<div class="fld" id="fldChapter" hidden><label>目标章节</label><select id="impChapter"></select><div class="hint" id="chStat"></div></div>'
        + '<div class="fld"><label id="impBodyLab">正文</label><textarea id="impBody" rows="6"></textarea></div>'
        + '<div class="fld"><label>或从 txt 文件读取（读入后可在上方预览/编辑）</label>'
        + '<input type="file" id="impFile" accept=".txt,text/plain"><div class="hint" id="encHint"></div></div>'
        + '<div class="row"><button class="primary" id="preCheckBtn">预检（识别结构）</button><button id="doImport" disabled>确认导入</button></div>'
        + '<div class="note" id="impNote">预检只识别不写库；确认后才落库。并入模式只追加，绝不改动既有内容；重名标题仅提示，不自动合并。</div>'
        + '</div>';

      // 字段联动：sectionOnly 固定为“并入指定章”（隐藏模式/书名选择）；split/chapterOnly 随模式切换
      function mode() { var r = body.querySelector('input[name="impMode"]:checked'); return r ? r.value : 'new'; }
      function format() { var r = body.querySelector('input[name="impFmt"]:checked'); return r ? r.value : 'split'; }
      function toggleFields() {
        var sec = format() === 'sectionOnly';
        var merge = sec || mode() === 'merge';
        q('#fldMode').hidden = sec;
        q('#fldTitle').hidden = merge;
        q('#fldBook').hidden = !merge;
        q('#fldChapter').hidden = !sec;
        var fmt = format();
        q('#impBodyLab').textContent = fmt === 'split'
          ? '正文（识别“第X章 / 第X节”两层结构，节挂到所属章下）'
          : fmt === 'chapterOnly'
            ? '正文（只按“第X章”分章；“第X节”等行原样并入所在章正文，不丢字）'
            : '正文（只按“第X节”切节，全部追加到下方所选章节之下）';
        q('#impBody').setAttribute('placeholder', fmt === 'sectionOnly'
          ? '\u3000第1节 小节标题\n\u3000\u3000正文…\n\u3000第2节 小节标题\n\u3000\u3000正文…'
          : '封面\n名称：书名\n作者：xxx\n\u3000第1章 标题\n\u3000\u3000正文…\n\u3000第1节 小节标题\n\u3000\u3000正文…');
        q('#fmtHint').textContent = fmt === 'split'
          ? '封面/文体/类别/风格/时间/长度/阅读显示等本软件没有的信息将被忽略（预检可见行数）；节会挂到所属章下。'
          : fmt === 'chapterOnly'
            ? '只识别章标题；没有章标题则整篇作为一章导入。'
            : '单节录入：不建书不建章，识别“第X节”切节并追加进所选章；章标题行会并入节正文。';
        showBookStat();
        if (sec) loadChapters();
      }
      // sectionOnly 两级下拉：目标书变化时刷新章清单
      function loadChapters() {
        var bid = q('#impBook').value;
        if (!bid) { q('#impChapter').innerHTML = ''; q('#chStat').textContent = ''; return; }
        DB.listChapters(bid).then(function (chs) {
          q('#impChapter').innerHTML = chs.map(function (c) {
            return '<option value="' + c.id + '">' + esc(c.idx + '. ' + (c.title || '未命名')) + '</option>';
          }).join('');
          q('#chStat').textContent = '将追加到《' + (findOptionText(bid) || '') + '》所选章之下；所选章正文与既有节一字不碰。';
        });
      }
      // 目标书统计：“书名（N 章 · M 字）”口径展示在下方提示
      function showBookStat() {
        if (format() === 'sectionOnly' || mode() !== 'merge') { q('#bookStat').textContent = ''; return; }
        var bid = q('#impBook').value;
        DB.listChapters(bid).then(function (chs) {
          var words = chs.reduce(function (a, c) { return a + (c.word_count || 0); }, 0);
          q('#bookStat').textContent = '当前选择：' + chs.length + ' 章 · ' + words + ' 字，导入将追加到第 ' + (chs.length + 1) + ' 章起。';
        });
      }
      [].forEach.call(body.querySelectorAll('input[name="impMode"]'), function (r) { on(r, 'change', toggleFields); });
      [].forEach.call(body.querySelectorAll('input[name="impFmt"]'), function (r) { on(r, 'change', function () { pending = null; q('#doImport').disabled = true; toggleFields(); }); });
      on(q('#impBook'), 'change', function () { showBookStat(); if (format() === 'sectionOnly') loadChapters(); });
      // txt 文件选取：按字节读 → SI.decodeTxt（UTF-8 优先，替换符过多回退 GB18030）→ 填进粘贴框预览
      on(q('#impFile'), 'change', function () {
        var f = q('#impFile').files && q('#impFile').files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () {
          try {
            var SI = root.NOVEL_STRUCTURED_IMPORT;
            var dec = (SI && SI.decodeTxt) ? SI.decodeTxt(new Uint8Array(fr.result)) : { text: '', encoding: '?' };
            q('#impBody').value = dec.text;
            q('#encHint').textContent = '已读取 ' + f.name + ' · 检测编码：' + dec.encoding + ' · ' + dec.text.length + ' 字，可在上方预览/编辑后预检。';
            pending = null; q('#doImport').disabled = true;
          } catch (e) { App().toast('读取文件失败：' + (e.message || e), 'bad'); }
        };
        fr.onerror = function () { App().toast('读取文件失败', 'bad'); };
        fr.readAsArrayBuffer(f);
      });
      toggleFields();

      // 预检：纯本地解析，三格式各走各的降维（split 树 / chapterOnly 扁平章 / sectionOnly 追加节），
      // 展示结构后二次确认；并入/追加模式额外比对现有章标题，重名只提示不自动合并（保守）。
      var pending = null;   // { format, mode, bookId, chapterId, title, text }
      on(q('#preCheckBtn'), 'click', function () {
        var text = String(q('#impBody').value || '');
        if (!text.trim()) { App().toast('请先粘贴或选择要导入的正文', 'warn'); return; }
        var SI = root.NOVEL_STRUCTURED_IMPORT;
        if (!SI) { App().toast('外部导入解析器未加载', 'bad'); return; }
        var fmt = format(), m = mode();
        var title = (q('#impTitle').value || '').trim();
        var bookId = m === 'merge' ? q('#impBook').value : '';
        if (fmt === 'sectionOnly') {   // 单节：并入指定章，不建书不建章
          var chapId = q('#impChapter').value;
          if (!bookId || !chapId) { App().toast('单节录入请先选择目标书籍与章节', 'warn'); return; }
          var sp = SI.parseSections(text);
          if (!sp.sections.length) { App().toast('未识别到任何“第X节”标题，无法按单节录入', 'warn'); return; }
          showPreCheckSections(sp, bookId, chapId, text);
          return;
        }
        if (fmt === 'chapterOnly') {   // 单章：只切章，节行降级并入正文
          var cp = SI.parseChapters(text);
          if (m === 'new' && !title && cp.bookMeta.title) { title = cp.bookMeta.title; q('#impTitle').value = title; }
          mergeAware(m, bookId, cp, function (dups) { showPreCheckChapters(cp, m, bookId, title || '导入作品', text, dups); });
          return;
        }
        // split（章节分开录入，默认）：章 > 节 两层树
        var parsed = SI.parse(text);
        if (!parsed.chapters.length) { App().toast('未识别到任何“第X章/第X节”标题，请改用其它录入格式', 'warn'); return; }
        if (m === 'new' && !title && parsed.bookMeta.title) { title = parsed.bookMeta.title; q('#impTitle').value = title; }  // 回填可改，改后即界面优先
        mergeAware(m, bookId, parsed, function (dups) { showPreCheckTree(parsed, m, bookId, title || '导入作品', text, dups); });
      });
      // 并入模式：先取现有章标题算重名再回调；新建直接回调。bundle 为 parts 数组或 parsed 树（取 chapters）
      function mergeAware(m, bookId, bundle, cb) {
        if (m !== 'merge') { cb([]); return; }
        var chList = Array.isArray(bundle) ? bundle : (bundle.chapters || []);
        DB.listChapters(bookId).then(function (chs) {
          var exist = {};
          chs.forEach(function (c) { if (c.title) exist[String(c.title).trim()] = true; });
          var dups = [];
          chList.forEach(function (c) { if (c.title && exist[String(c.title).trim()]) dups.push(String(c.title).trim()); });
          cb(dups);
        });
      }
      function dupNote(dups) {
        return dups.length
          ? '<div class="note">⚠ 有 ' + dups.length + ' 个标题与现有章节重名（' + esc(dups.slice(0, 3).join('、')) + (dups.length > 3 ? '…' : '') + '），将按新章追加，不自动合并。</div>' : '';
      }

      // structured 树形预检（§M-C-3）
      function showPreCheckTree(parsed, m, bookId, title, text, dups) {
        var st = parsed.report.stats, CN = root.NOVEL_STRUCTURED_IMPORT.countNonSpace;
        var actDesc = m === 'merge'
          ? '将向《' + esc(findOptionText(bookId) || '') + '》追加 ' + st.chapters + ' 章（含 ' + st.sections + ' 节），原有章节不改动。'
          : '《' + esc(title) + '》将新建 ' + st.chapters + ' 章 · ' + st.sections + ' 节。';
        var lines = parsed.chapters.map(function (c, i) {
          var cw = CN(c.body), empty = !c.body && !c.sections.length;
          var t = (i + 1) + '. ' + esc(c.title || '（无题）')
            + (c.sections.length ? '（' + c.sections.length + ' 节 · ' + cw + ' 字）' : '（' + cw + ' 字）')
            + (empty ? ' <span class="tag">空章</span>' : '');
          var subs = c.sections.map(function (s, j) {
            return '　　' + (i + 1) + '.' + (j + 1) + ' ' + esc(s.title || '（无题）') + ' · ' + CN(s.body) + ' 字';
          }).join('<br>');
          return t + (subs ? '<br>' + subs : '');
        }).join('<br>');
        var dropLine = parsed.report.dropped.metaLines ? '<div class="hint">已忽略 ' + parsed.report.dropped.metaLines + ' 行封面信息（本软件无此项）。</div>' : '';
        var anom = parsed.report.anomalies.length
          ? '<div class="note">⚠ ' + parsed.report.anomalies.map(esc).join('<br>⚠ ') + '</div>' : '';
        var panel = openSheet('importConfirm', '<div class="sh-title">导入预检 · 外部结构</div>'
          + '<div class="note">识别到 <b>' + st.chapters + '</b> 章 · <b>' + st.sections + '</b> 节 · 共 ' + st.words + ' 字。' + actDesc + '</div>'
          + '<div class="probe">' + lines + '</div>' + dropLine + anom + dupNote(dups)
          + '<div class="hint">节正文暂不参与全文检索（检索仅覆盖章标题/正文）。</div>'
          + '<div class="row"><button class="primary" data-icok>确认导入</button><button class="ghost" data-closesheet>取消</button></div>');
        pending = { format: 'split', mode: m, bookId: bookId, title: title, text: text };
        q('#doImport').disabled = false;
        on(panel.querySelector('[data-icok]'), 'click', function () { closeSheet('importConfirm'); doImport(pending); });
      }
      // chapterOnly 扁平章预检（单章录入：不建节，节行已并入章正文）
      function showPreCheckChapters(parsed, m, bookId, title, text, dups) {
        var st = parsed.report.stats, CN = root.NOVEL_STRUCTURED_IMPORT.countNonSpace;
        var actDesc = m === 'merge'
          ? '将向《' + esc(findOptionText(bookId) || '') + '》追加 ' + st.chapters + ' 章，原有章节不改动。'
          : '《' + esc(title) + '》将新建 ' + st.chapters + ' 章。';
        var lines = parsed.chapters.map(function (c, i) {
          var cw = CN(c.body), empty = !c.body;
          return (i + 1) + '. ' + esc(c.title || '（无题）') + '（' + cw + ' 字）' + (empty ? ' <span class="tag">空章</span>' : '');
        }).join('<br>');
        var dropLine = parsed.report.dropped.metaLines ? '<div class="hint">已忽略 ' + parsed.report.dropped.metaLines + ' 行封面信息（本软件无此项）。</div>' : '';
        var anom = parsed.report.anomalies.length
          ? '<div class="note">⚠ ' + parsed.report.anomalies.map(esc).join('<br>⚠ ') + '</div>' : '';
        var panel = openSheet('importConfirm', '<div class="sh-title">导入预检 · 单章录入</div>'
          + '<div class="note">识别到 <b>' + st.chapters + '</b> 章 · 共 ' + st.words + ' 字。' + actDesc + '</div>'
          + '<div class="probe">' + lines + '</div>' + dropLine + anom + dupNote(dups)
          + '<div class="hint">单章录入不建节；“第X节”等标题行已原样并入所在章正文，不丢字。</div>'
          + '<div class="row"><button class="primary" data-icok>确认导入</button><button class="ghost" data-closesheet>取消</button></div>');
        pending = { format: 'chapterOnly', mode: m, bookId: bookId, title: title, text: text };
        q('#doImport').disabled = false;
        on(panel.querySelector('[data-icok]'), 'click', function () { closeSheet('importConfirm'); doImport(pending); });
      }

      // sectionOnly 追加节预检（单节录入：向所选章尾部追加，章正文与既有节一字不碰）
      function showPreCheckSections(sp, bookId, chapId, text) {
        var st = sp.report.stats, CN = root.NOVEL_STRUCTURED_IMPORT.countNonSpace;
        var bookName = findOptionText(bookId) || '';
        var chSel = q('#impChapter');
        var chName = chSel && chSel.selectedIndex >= 0 && chSel.options[chSel.selectedIndex] ? chSel.options[chSel.selectedIndex].text : '';
        var lines = sp.sections.map(function (s, j) {
          return (j + 1) + '. ' + esc(s.title || '（无题）') + ' · ' + CN(s.body) + ' 字' + (!s.body ? ' <span class="tag">空节</span>' : '');
        }).join('<br>');
        var anom = sp.report.anomalies.length
          ? '<div class="note">⚠ ' + sp.report.anomalies.map(esc).join('<br>⚠ ') + '</div>' : '';
        var panel = openSheet('importConfirm', '<div class="sh-title">导入预检 · 单节录入</div>'
          + '<div class="note">将向《' + esc(bookName) + '》' + esc(chName) + ' 追加 <b>' + st.sections + '</b> 节 · 共 ' + st.words + ' 字；该章正文与既有节一字不碰。</div>'
          + '<div class="probe">' + lines + '</div>' + anom
          + '<div class="hint">节正文暂不参与全文检索（检索仅覆盖章标题/正文）。</div>'
          + '<div class="row"><button class="primary" data-icok>确认导入</button><button class="ghost" data-closesheet>取消</button></div>');
        pending = { format: 'sectionOnly', mode: 'merge', bookId: bookId, chapterId: chapId, title: '', text: text };
        q('#doImport').disabled = false;
        on(panel.querySelector('[data-icok]'), 'click', function () { closeSheet('importConfirm'); doImport(pending); });
      }
      function findOptionText(bid) {
        var sel = q('#impBook');
        for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === String(bid)) return sel.options[i].text;
        return '';
      }

      // 执行导入：透传 format 与 chapterId；split/chapterOnly 报“N 章 · M 节”，sectionOnly 报“追加 M 节”
      function doImport(pk) {
        App().toast('导入中…');
        DA().importBook(dataDeps(), { mode: pk.mode, bookId: pk.bookId, chapterId: pk.chapterId, title: pk.title, text: pk.text, format: pk.format }).then(function (r) {
          pending = null;
          q('#doImport').disabled = true;
          if (pk.format === 'sectionOnly') {
            App().toast('已追加 ' + r.sections + ' 节到所选章', 'ok');
            App().go('#/book/' + r.bookId + '/chapters');
            return;
          }
          var sec = r.sections ? ' · ' + r.sections + ' 节' : '';
          App().toast((r.mode === 'merge' ? '已追加 ' : '已导入并建新书，共 ') + r.chapters + ' 章' + sec, 'ok');
          App().go('#/book/' + r.bookId + '/chapters');
        }, function (e) {
          var unit = pk.format === 'sectionOnly' ? '节' : '章';
          var part = (e && e.imported != null) ? '（已成功 ' + e.imported + '/' + e.total + ' ' + unit + '，可修正后重试）' : '';
          App().toast('导入失败：' + ((e && e.message) || e) + part, 'bad');
        });
      }
      // 确认后按钮才允许直接重放同一预检结果（防误导入：未预检不可落库）
      on(q('#doImport'), 'click', function () {
        if (!pending) { App().toast('请先点“预检”确认结构', 'warn'); return; }
        doImport(pending);
      });
      on(q('#impBody'), 'input', function () { pending = null; q('#doImport').disabled = true; });
    });
  }

  /* ================= 问题反馈（建议 8）：邮箱展示/复制 + mailto 发信（不支持时降级复制） ================= */
  function renderMeFeedback(body) {
    body.innerHTML = '<div class="sec-head"><span class="st">问题反馈</span></div><div class="form">'
      + '<div class="note">欢迎提出建议或提交 bug。请附上版本号与复现步骤，方便定位；邮箱是唯一反馈渠道，响应不作时效承诺。</div>'
      + '<div class="fld"><label>开发者邮箱</label><div class="fb-mail" id="fbMailText">' + FEEDBACK_EMAIL + '</div></div>'
      + '<div class="row"><button id="fbCopy">复制邮箱</button><button class="primary" id="fbOpen">打开发送邮件</button></div>'
      + '<h2 class="sec">反馈模板（可选，自动带入邮件正文）</h2>'
      + '<div class="fld"><label>类型</label><select id="fbKind"><option>建议</option><option>bug</option></select></div>'
      + '<div class="fld"><label>内容 / 复现步骤</label><textarea id="fbText" rows="4" placeholder="发生了什么？期望是什么？"></textarea></div>'
      + '<div class="row"><button class="primary" id="fbCompose">生成邮件并发送</button></div>'
      + '<div class="hint">机型/系统与 App 版本会自动附加。若本机未安装邮件应用，会降级为“已复制邮箱与内容，请手动发送”。</div>'
      + '</div>';
    on(q('#fbCopy'), 'click', function () { copyText(FEEDBACK_EMAIL); });
    // mailto 拉起系统邮件 App；WebView 不支持时无法探测成败，统一先备一份剪贴板内容供手动粘贴
    function openMailto(subject, content) {
      copyText(FEEDBACK_EMAIL + '\n' + content);
      try {
        var a = root.document.createElement('a');
        a.href = 'mailto:' + FEEDBACK_EMAIL + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(content);
        root.document.body.appendChild(a); a.click(); root.document.body.removeChild(a);
        App().toast('已拉起邮件（若无反应，邮箱与内容已复制，请手动发送）', 'ok');
      } catch (e) {
        App().toast('本机不支持直接发信：邮箱与内容已复制，请手动发送', 'warn');
      }
    }
    on(q('#fbOpen'), 'click', function () { openMailto('[反馈] AI 写作助手', '反馈类型：\nApp 版本：' + APP_VERSION + '\n机型/系统：' + deviceInfo() + '\n内容：'); });
    on(q('#fbCompose'), 'click', function () {
      var kind = q('#fbKind').value;
      var txt = String(q('#fbText').value || '').trim();
      if (!txt) { App().toast('请先填写反馈内容', 'warn'); return; }
      var head2 = kind === 'bug'
        ? '反馈类型：bug\nApp 版本：' + APP_VERSION + '\n机型/系统：' + deviceInfo() + '\n复现步骤与期望：'
        : '反馈类型：建议\nApp 版本：' + APP_VERSION + '\n机型/系统：' + deviceInfo() + '\n建议内容：';
      openMailto('[' + kind + '] AI 写作助手反馈', head2 + '\n' + txt);
    });
  }
  function deviceInfo() {
    try { return String((root.navigator && root.navigator.userAgent) || '未知设备'); } catch (e) { return '未知设备'; }
  }

  root.NOVEL_VIEWS = { shelf: shelf, book: book, chapter: chapter, editor: editor, section: section, me: me,
    BUILTIN: BUILTIN, ME_TABS: ME_TABS, FEEDBACK_EMAIL: FEEDBACK_EMAIL };
})(globalThis);
