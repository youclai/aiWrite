/* txt 导出（F41）：把作品的章节拼成可投稿/可分享的纯文本，纯函数组装 + 经 NOVEL_TEMP 落 temp/export。
   默认档=纯正文（不加标题行、不加章号），段与段之间空行分隔；可选带章号/标题头。
   BOM（\uFEFF）只在写盘时前置，保证 Windows/记事本按 UTF-8 正确识别；组装函数本身不含 BOM，便于单测比对。
   本模块不直接碰 fs：落盘统一走注入的 temp（NOVEL_TEMP）或自定义 sink，Node 测试注入内存 sink 即可断言。 */
(function (root) {
  'use strict';

  var BOM = '\uFEFF';

  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function safeFile(s) {
    return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim() || 'untitled';
  }

  // 单章正文（默认不含标题/章号）；opts.includeNumber 加"第N章 标题"头，opts.includeTitle 仅加标题
  function chapterText(ch, opts) {
    opts = opts || {};
    var body = String(ch.body || '').replace(/\r\n/g, '\n').trim();
    var head = '';
    if (opts.includeNumber) head = '第' + (ch.idx != null ? ch.idx : '') + '章　' + (ch.title || '') + '\n\n';
    else if (opts.includeTitle && ch.title) head = ch.title + '\n\n';
    return head + body;
  }

  // 整本拼接：章之间空一个整行
  function fullText(book, chapters, opts) {
    opts = opts || {};
    var parts = (chapters || []).map(function (c) { return chapterText(c, opts); });
    var body = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (opts.includeFrontmatter && book) {
      var fm = (book.title || '') + (book.author ? '\n作者：' + book.author : '');
      if (book.synopsis) fm += '\n\n' + book.synopsis;
      body = fm.trim() + '\n\n\n' + body;
    }
    return body;
  }

  // 分章文件清单：每章一个 {name, text}，名字带序号防乱序
  function chapterFiles(chapters, opts) {
    opts = opts || {};
    return (chapters || []).map(function (c, i) {
      var no = c.idx != null ? c.idx : (i + 1);
      var name = pad2(no) + ' ' + safeFile(c.title || ('第' + no + '章')) + '.txt';
      return { name: name, text: chapterText(c, opts) };
    });
  }

  // 写盘：txt 用 utf8 字符串，BOM 前置。sink 默认取 NOVEL_TEMP.write('export', name, ...)
  function writeTxt(name, text, sink) {
    var w = sink || root.NOVEL_TEMP;
    if (!w || typeof w.write !== 'function') return Promise.reject(new Error('导出需要一个可写的 sink（NOVEL_TEMP 未就绪）'));
    return Promise.resolve(w.write('export', name, BOM + text));
  }

  root.NOVEL_EXPORTER = {
    BOM: BOM,
    chapterText: chapterText, fullText: fullText, chapterFiles: chapterFiles,
    writeTxt: writeTxt, safeFile: safeFile, pad2: pad2
  };
})(globalThis);
