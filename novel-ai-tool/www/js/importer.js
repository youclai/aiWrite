/* txt 导入分章（F46）：把一大段纯文本切成 [{title, body}]，纯函数、无 IO、Node 可全单测。
   规则（自上而下）：
   1) 逐行识别"章标题"：第X章/节/回/卷/篇（含中文数字）、chapter N、序言/楔子/尾声/后记/番外…
   2) 命中即开新章，标题=该行原文（trim），其后内容归入本章正文；标题行本身不进正文
   3) 首个标题之前的零星文字不丢：作为无标题的"引子"块保留
   4) 全文一个标题都没命中 → 降级按空行分块，每块一章（title 空），绝不整篇塞成一坨
   5) 归一 \r\n / \r → \n；每章正文裁掉首尾空行；正文为空的空章丢弃 */
(function (root) {
  'use strict';

  var NUM = '[0-9〇零一二三四五六七八九十百千万两壹贰叁]+';
  // 一章之起的行首标记；捕获整行做标题
  var CHAPTER_LINE = new RegExp(
    '^\\s*(?:' +
    '第\\s*' + NUM + '\\s*[章节回卷篇折]' +        // 第12章 / 第十二章 / 第三回
    '|chapter\\s*\\d+' +                              // chapter 3
    '|第\\s*\\d+\\s*[章节回]' +                        // 第 1 节
    '|(?:序\\s*[言章]|楔\\s*子|尾\\s*声|后\\s*记|前\\s*言|附\\s*录|番外)' + // 特殊章
    ')'
  , 'i');

  function normalize(text) {
    return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function isChapterLine(line) {
    return CHAPTER_LINE.test(line);
  }
  // 是否"看起来已分好章"：至少一行命中且能切出 ≥2 章
  function looksChaptered(text) {
    var lines = normalize(text).split('\n');
    var hit = 0;
    for (var i = 0; i < lines.length; i++) if (isChapterLine(lines[i])) hit++;
    return hit >= 1;
  }

  // 主入口：text → [{title, body}]
  function split(text, opts) {
    opts = opts || {};
    var src = normalize(text);
    if (!src.trim()) return [];

    var lines = src.split('\n');
    var chapters = [];
    var cur = null;          // {title, buf:[]}
    var preBuf = [];         // 首个标题之前的内容

    function flush(target, title) {
      var body = target.join('\n').replace(/^\s*\n+|\n+\s*$/g, '').trim();
      if (body) chapters.push({ title: (title || '').trim(), body: body });
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (isChapterLine(line)) {
        if (cur) flush(cur.buf, cur.title);
        else if (preBuf.some(function (l) { return l.trim(); })) flush(preBuf, '');   // 引子
        cur = { title: line, buf: [] };
      } else {
        (cur ? cur.buf : preBuf).push(line);
      }
    }
    if (cur) flush(cur.buf, cur.title);
    else if (preBuf.some(function (l) { return l.trim(); })) flush(preBuf, '');

    // 降级：一个章标题都没有 → 按空行分块
    if (!chapters.length || (!cur && chapters.length === 1 && chapters[0].title === '')) {
      // 上面走引子分支时 chapters 可能已含 1 个无标题整块；此处按空行重切以保证多块
      if (!chapters.length || opts.forceBlankSplit) {
        chapters = blankSplit(src);
      } else {
        var reSplit = blankSplit(src);
        if (reSplit.length > chapters.length) chapters = reSplit;
      }
    }
    return chapters;
  }

  function blankSplit(src) {
    return normalize(src)
      .split(/\n\s*\n+/)
      .map(function (b) { return b.trim(); })
      .filter(Boolean)
      .map(function (b) { return { title: '', body: b }; });
  }

  // 供界面拼回校验：切分结果无损（去掉空白差异后内容应一致）
  function join(chapters) {
    return (chapters || []).map(function (c) {
      return (c.title ? c.title + '\n' : '') + c.body;
    }).join('\n\n');
  }

  root.NOVEL_IMPORTER = {
    split: split, blankSplit: blankSplit, looksChaptered: looksChaptered,
    isChapterLine: isChapterLine, join: join, CHAPTER_LINE: CHAPTER_LINE
  };
})(globalThis);
