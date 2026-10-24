/* docx 导出（F42）：手写最小 OOXML（WordprocessingML），复用 NOVEL_ZIP 打包成 .docx 字节；零第三方依赖。
   为什么不用现成库：本项目无打包器、要能在 WebView 与 Node 同源跑，手写可控且能被结构断言（namelist/含 pageBreakBefore/页眉字数）。
   部件齐备即可被 Word/WPS 打开：[Content_Types].xml、_rels/.rels、word/document.xml、word/_rels/document.xml.rels、
   word/styles.xml、word/header1.xml。中文排版：正文首行缩进 2 字符(firstLineChars=200)、rFonts eastAsia=宋体；
   每章标题另起一页(pageBreakBefore)；页眉带"书名 · 全书 N 字"。全部产物为字符串，交 zip(STORE) 落字节。
   输入用调用方从 NOVEL_DB 取好的 book/chapters；纯计算、无 IO，落盘交注入 sink。 */
(function (root) {
  'use strict';

  var W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var RELDOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var PKGREL = 'http://schemas.openxmlformats.org/package/2006/relationships';
  var CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
  var XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      // 去掉 XML 1.0 非法控制字符，避免 Word 报"文件已损坏"
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  // 一个文本 run；xml:space="preserve" 保住行首尾空格（正文缩进/半角空格）
  function run(text, props) {
    var t = esc(text);
    return '<w:r>' + (props || '') + '<w:t xml:space="preserve">' + t + '</w:t></w:r>';
  }
  // 段落：opts.pageBreak 加 pageBreakBefore；opts.align 居中；styleId 应用样式
  function para(text, opts) {
    opts = opts || {};
    var ppr = '<w:pPr>';
    if (opts.styleId) ppr += '<w:pStyle w:val="' + opts.styleId + '"/>';
    if (opts.pageBreak) ppr += '<w:pageBreakBefore/>';
    if (opts.align) ppr += '<w:jc w:val="' + opts.align + '"/>';
    if (opts.noIndent) ppr += '<w:ind w:firstLine="0" w:firstLineChars="0"/>';
    ppr += '</w:pPr>';
    var bold = opts.bold ? '<w:rPr><w:b/></w:rPr>' : '';
    return '<w:p>' + ppr + run(text, bold) + '</w:p>';
  }

  // word/document.xml：标题页(可选) + 各章（标题另起一页 + 正文分段） + sectPr(引页眉)
  function documentXml(book, chapters, o) {
    var body = '';
    if (o.includeTitlePage !== false && book && book.title) {
      body += para(book.title, { styleId: 'Title', align: 'center', noIndent: true, bold: true });
      if (book.author) body += para('作者：' + book.author, { align: 'center', noIndent: true });
      if (book.synopsis) body += para(book.synopsis, { noIndent: true });
    }
    (chapters || []).forEach(function (c) {
      if (c.title) body += para(c.title, { styleId: 'Heading1', pageBreak: o.pageBreak !== false, noIndent: true, bold: true });
      String(c.body || '').replace(/\r\n/g, '\n').split('\n').forEach(function (line) {
        if (line.trim() !== '') body += para(line, { styleId: 'Body' });
      });
    });
    if (!body) body = para('', {});
    var sect = '<w:sectPr>'
      + (o.includeHeader !== false ? '<w:headerReference r:id="' + o.headerRelId + '" w:type="default"/>' : '')
      + '<w:pgSz w:w="11906" w:h="16838"/>'   // A4
      + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>'
      + '</w:sectPr>';
    return XMLDECL + '<w:document xmlns:w="' + W + '" xmlns:r="' + RELDOC + '"><w:body>' + body + sect + '</w:body></w:document>';
  }

  // word/styles.xml：正文首行缩进 2 字符 + eastAsia 字体；标题样式
  function stylesXml() {
    return XMLDECL + '<w:styles xmlns:w="' + W + '">'
      + '<w:docDefaults><w:rPrDefault><w:rPr>'
      + '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>'
      + '<w:sz w:val="24"/><w:szCs w:val="24"/>'   // 12pt
      + '</w:rPr></w:rPrDefault></w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:basedOn w:val="Normal"/>'
      + '<w:pPr><w:ind w:firstLineChars="200" w:firstLine="480"/><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>'
      + '<w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>'
      + '<w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style>'
      + '</w:styles>';
  }

  // word/header1.xml：页眉——"书名 · 全书 N 字"（字数由调用方传入，避免在纯函数里再数一遍）
  function headerXml(book, totalWords) {
    var t = ((book && book.title) || '作品') + ' · 全书 ' + (totalWords == null ? '' : totalWords) + ' 字';
    return XMLDECL + '<w:hdr xmlns:w="' + W + '" xmlns:r="' + RELDOC + '">'
      + para(t, { align: 'center', noIndent: true }) + '</w:hdr>';
  }

  function contentTypesXml(withHeader) {
    return XMLDECL + '<Types xmlns="' + CT + '">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
      + (withHeader ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '')
      + '</Types>';
  }

  function rootRelsXml() {
    return XMLDECL + '<Relationships xmlns="' + PKGREL + '">'
      + '<Relationship Id="rId1" Type="' + RELDOC + '/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>';
  }

  function documentRelsXml(withHeader) {
    return XMLDECL + '<Relationships xmlns="' + PKGREL + '">'
      + '<Relationship Id="rId1" Type="' + RELDOC + '/styles" Target="styles.xml"/>'
      + (withHeader ? '<Relationship Id="rId2" Type="' + RELDOC + '/header" Target="header1.xml"/>' : '')
      + '</Relationships>';
  }

  // 主入口：book + chapters(+总字数) → { entries, bytes }
  function build(book, chapters, opts) {
    opts = opts || {};
    var ZIP = root.NOVEL_ZIP;
    if (!ZIP) throw new Error('docx 依赖 NOVEL_ZIP（请先加载 zip.js）');
    var o = {
      includeHeader: opts.includeHeader !== false,
      includeTitlePage: opts.includeTitlePage,
      pageBreak: opts.pageBreak,
      headerRelId: 'rId2'
    };
    var entries = [
      { name: '[Content_Types].xml', data: contentTypesXml(o.includeHeader) },
      { name: '_rels/.rels', data: rootRelsXml() },
      { name: 'word/document.xml', data: documentXml(book, chapters, o) },
      { name: 'word/_rels/document.xml.rels', data: documentRelsXml(o.includeHeader) },
      { name: 'word/styles.xml', data: stylesXml() },
    ];
    if (o.includeHeader) entries.push({ name: 'word/header1.xml', data: headerXml(book, opts.totalWords) });
    return { entries: entries, bytes: ZIP.build(entries), names: entries.map(function (e) { return e.name; }) };
  }

  /* ---------- 读外部 docx（优化批次 A）：解压 + 取正文，产出纯文本后交回现有导入链路 ----------
     不引第三方 DOM：按 <w:p>…</w:p> 切段落，段内顺序收集 <w:t> 文本与 <w:tab/>/<w:br/>；
     域代码 <w:instrText> 与修订删除 <w:del> 包裹内文本丢弃，插入 <w:ins> 保留（普通收集即可命中）；
     段落间用单个 \n 连接，交下游按“章节分开录入/自动切分”规则再处理。 */
  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  function decodeEntities(s) {
    return String(s).replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#[xX][0-9a-fA-F]+);/g, function (m, k) {
      if (k.charAt(0) === '#') {
        var code = k.charAt(1) === 'x' || k.charAt(1) === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return (code >= 0 && code <= 0x10FFFF) ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[k] != null ? ENTITIES[k] : m;
    });
  }

  // 单段 XML 内容 → 纯文本（无文本返回空串）
  function paraText(inner) {
    var s = inner
      .replace(/<w:instrText(?:\s[^>]*)?>[\s\S]*?<\/w:instrText>/g, '')   // 域代码不混进正文
      .replace(/<w:noBreakHyphen\b[^>]*\/>/g, '-');
    var out = '', RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g, m;
    while ((m = RE.exec(s))) {
      if (m[1] != null) out += decodeEntities(m[1]);
      else if (m[0].indexOf('<w:tab') === 0) out += '\t';
      else out += '\n';   // br/cr → 换行（段内软换行保留为硬换行）
    }
    return out;
  }

  // document.xml → 全篇纯文本（同步，已解压的 XML 串入参；导出供测试直接验段落解析）
  function documentToText(xml) {
    xml = String(xml == null ? '' : xml)
      .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '')      // 修订“删除”包裹内文本丢弃
      .replace(/<w:moveFrom\b[^>]*>[\s\S]*?<\/w:moveFrom>/g, '');
    var paras = [], RE = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g, m;
    while ((m = RE.exec(xml))) {
      var t = paraText(m[1]);
      if (t !== '') paras.push(t);   // 空段/只有标记的段丢弃，不产生多余空行
    }
    return paras.join('\n');
  }

  // 主入口：docx 字节（STORE/DEFLATE 都可）→ Promise<纯文本>；opts.inflate 透传 zip.listAsync（Node 测试注入 zlib）
  function extractText(bytes, opts) {
    var ZIP = root.NOVEL_ZIP;
    if (!ZIP || !ZIP.listAsync) return Promise.reject(new Error('读 docx 需要 NOVEL_ZIP.listAsync（请先加载 zip.js）'));
    return ZIP.listAsync(bytes, opts).then(function (entries) {
      var doc = null;
      for (var i = 0; i < entries.length; i++) if (entries[i].name === 'word/document.xml') { doc = entries[i]; break; }
      if (!doc) throw new Error('不是有效的 Word 文档（缺 word/document.xml）；旧版 .doc 请另存为 .docx 或 .txt');
      var text;
      try { text = documentToText(doc.text()); } catch (e) { text = documentToText(safeDecode(doc.data)); }
      if (!text || !text.trim()) throw new Error('文档正文为空或只含域代码/批注');
      return text;
    });
  }
  function safeDecode(u8) { try { return new TextDecoder().decode(u8); } catch (e) { return ''; } }

  root.NOVEL_DOCX = {
    build: build,
    extractText: extractText, documentToText: documentToText,   // 读取侧（优化批次 A）
    // 部件生成器暴露给测试/复用
    parts: { documentXml: documentXml, stylesXml: stylesXml, headerXml: headerXml, contentTypesXml: contentTypesXml, esc: esc, para: para }
  };
})(globalThis);
