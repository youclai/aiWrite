/* 作品 zip（F44）：把一本书打包成便于迁移/分享的 zip——全本 txt + 分章 txt + 角色卡 md + 章节结构 md。
   纯计算：输入是调用方从 NOVEL_DB 取好的 book/chapters/characters，输出 Uint8Array；落 temp/export 由 sink 决定。
   全部派生物只进 zip（后续写盘交 NOVEL_TEMP / Filesystem），不散落外部存储。docx/备份包复用 NOVEL_ZIP 同套容器。 */
(function (root) {
  'use strict';

  var EXP = root.NOVEL_EXPORTER;
  var ZIP = root.NOVEL_ZIP;

  // 别名可能来自内存对象（数组）或 DB 行（JSON 字符串/分隔串），统一归一成数组
  function asList(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      var s = v.trim(); if (!s) return [];
      try { var j = JSON.parse(s); if (Array.isArray(j)) return j; } catch (e) {}
      return s.split(/[、,，]/).map(function (x) { return x.trim(); }).filter(Boolean);
    }
    return [];
  }

  function charactersMd(chars) {
    var lines = ['# 角色卡', ''];
    (chars || []).forEach(function (c) {
      lines.push('## ' + (c.name || '未命名'));
      if (c.role) lines.push('- 定位：' + c.role);
      var al = asList(c.aliases);
      if (al.length) lines.push('- 别名：' + al.join('、'));
      if (c.personality) lines.push('- 性格：' + c.personality);
      if (c.speech_style) lines.push('- 说话风格：' + c.speech_style);
      if (c.taboos) lines.push('- 禁忌：' + c.taboos);
      lines.push('');
    });
    return lines.join('\n');
  }

  // 章节结构：一行一章的目录（idx/标题/字数/摘要），迁移后能速览全书骨架
  function outlineMd(book, chapters) {
    var lines = ['# ' + ((book && book.title) || '作品') + ' · 章节结构', ''];
    (chapters || []).forEach(function (c) {
      lines.push('- 第' + (c.idx != null ? c.idx : '?') + '章 ' + (c.title || '')
        + '（' + (c.word_count || EXP.chapterText(c, {}).replace(/\s/g, '').length) + ' 字）'
        + (c.summary ? '　' + String(c.summary).replace(/\n/g, ' ') : ''));
    });
    return lines.join('\n') + '\n';
  }

  // 生成作品包条目并打成 zip（Uint8Array）。entries 同时返回，便于测试直接查清单。
  function buildNovelZip(book, chapters, characters) {
    var base = EXP.safeFile((book && book.title) || 'novel');
    var entries = [];
    // 全本（带章号头，便于人读）
    entries.push({ name: base + '.txt', data: EXP.BOM + EXP.fullText(book, chapters, { includeNumber: true, includeFrontmatter: true }) });
    // 分章
    EXP.chapterFiles(chapters, { includeNumber: true }).forEach(function (f) {
      entries.push({ name: base + '/分章/' + f.name, data: EXP.BOM + f.text });
    });
    // 角色卡 & 结构
    entries.push({ name: base + '/角色卡.md', data: charactersMd(characters) });
    entries.push({ name: base + '/章节结构.md', data: outlineMd(book, chapters) });

    return { base: base, entries: entries, bytes: ZIP.build(entries) };
  }

  // 写盘：sink 需支持二进制（Node 测试用内存 sink；真机走 Filesystem base64）。默认交 NOVEL_TEMP 时仅字符串可用，
  // 因此二进制落盘必须显式传 sink；这里不臆造 temp 的二进制能力。
  function writePackage(bytes, name, sink) {
    if (!sink || (typeof sink.writeBytes !== 'function' && typeof sink.write !== 'function')) {
      return Promise.reject(new Error('写作品包需要一个能落字节的 sink'));
    }
    if (typeof sink.writeBytes === 'function') return Promise.resolve(sink.writeBytes('export', name, bytes));
    return Promise.resolve(sink.write('export', name, bytes));
  }

  root.NOVEL_ZIPPER = {
    buildNovelZip: buildNovelZip, writePackage: writePackage,
    charactersMd: charactersMd, outlineMd: outlineMd
  };
})(globalThis);
