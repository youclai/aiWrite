/* 外部导入（章 > 节两层结构）：把"封面信息头 + 第N章 标题 + 第N节 标题 + 缩进正文"这类
   纯文本解析成 {bookMeta, chapters:[{...,sections:[]}], report} 树。零依赖、零 IO、纯函数，
   Node 可 new Function(src)(globalThis) 直测（见 tests/m9_structured.test.cjs）。
   与 importer.js（自动按"第X章"切平铺章）互斥：本解析器保留"节挂到所属章下"的层级，
   且本软件没有的封面字段整行丢弃并留痕。规则来源见 .qoder 计划文档 §3。 */
(function (root) {
  'use strict';

  var NUM = '[0-9〇零一二三四五六七八九十百千万两]+';
  var CH_KW = '[章回卷篇折]';   // 章类关键字（节永不混用：节关键字优先级更高）

  // 8 级行分类正则（自上而下短路）。裸题/严格/宽松分别对 1-2 / 3-4 / 5-7 形。
  var RE_BARE_SEC = new RegExp('^第\\s*(' + NUM + ')\\s*节[\\s\\u3000]*$');
  var RE_BARE_CHAP = new RegExp('^第\\s*(' + NUM + ')\\s*' + CH_KW + '[\\s\\u3000]*$');
  var RE_STRICT_SEC = new RegExp('^第\\s*(' + NUM + ')\\s*节[ \\t\\u3000]+(.*)$');
  var RE_STRICT_CHAP = new RegExp('^第\\s*(' + NUM + ')\\s*' + CH_KW + '[ \\t\\u3000]+(.*)$');
  var RE_LOOSE_SEC = new RegExp('^第\\s*(' + NUM + ')\\s*节(\\S.*)$');
  var RE_LOOSE_CHAP = new RegExp('^第\\s*(' + NUM + ')\\s*' + CH_KW + '(\\S.*)$');
  var RE_DOTTED = new RegExp('^(\\d{1,4})\\.(\\d{1,4})[ \\t\\u3000]+(\\S.*)$');
  var RE_FRONTKV = new RegExp('^(.{1,8}?)\\s*[:：]\\s*(.*)$');
  var RE_HEADPUNCT = /[。！？；，、…”』）〉?!;:,\u201d]/;

  var TITLE_KEYS = ['名称', '书名', '标题', '作品名'];
  var AUTHOR_KEYS = ['作者'];
  var SYNOPSIS_KEYS = ['简介', '梗概', '摘要', '内容提要'];
  var DROP_KEYS = ['文体', '类别', '类型', '风格', '标签', '时间', '长度', '字数', '章数', '状态',
    '阅读章显示', '阅读节显示', '阅读章', '阅读节', '显示', '排版', '字号', '行距', '出版社', '更新'];

  function inSet(key, set) { return set.indexOf(key) >= 0; }

  /* ---------- 归一化与计数 ---------- */
  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }
  // 非空白字符数（\s 已涵盖 U+3000/NBSP），Array.from 保证中文/emoji 逐字计数
  function countNonSpace(text) {
    var n = 0;
    Array.from(String(text || '')).forEach(function (c) { if (!/\s/.test(c)) n++; });
    return n;
  }

  /* ---------- 中文数字解析（仅用于层级判定与提示，不参与落库 idx） ---------- */
  var DIGIT = { '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  var UNIT = { '十': 10, '百': 100, '千': 1000 };
  function zh2num(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
    var hasUnit = false, hasWan = false, i;
    for (i = 0; i < s.length; i++) { var c = s[i]; if (UNIT[c]) hasUnit = true; if (c === '万') hasWan = true; }
    if (!hasUnit && !hasWan) {   // 只有数字位 → 按位拼接：〇→0、一二三→123
      var out = '', ok = true;
      for (i = 0; i < s.length; i++) {
        var d = s[i];
        if (DIGIT[d] !== undefined) out += DIGIT[d];
        else if (/[0-9]/.test(d)) out += d;
        else { ok = false; break; }
      }
      return (ok && out.length) ? parseInt(out, 10) : null;
    }
    var total = 0, section = 0, num = -1;   // 位权算法：十二→12、一百零八→108、一万→10000
    for (i = 0; i < s.length; i++) {
      var ch = s[i];
      if (DIGIT[ch] !== undefined) num = DIGIT[ch];
      else if (UNIT[ch]) { if (num < 0) num = 1; section += num * UNIT[ch]; num = -1; }
      else if (ch === '万') { if (num < 0 && section === 0) num = 1; total += (section + (num > 0 ? num : 0)) * 10000; section = 0; num = -1; }
      else return null;
    }
    return total + section + (num > 0 ? num : 0);
  }

  /* ---------- 标题形状护栏（排除"他走了进来。"被吞成标题） ---------- */
  function titleLooksLikeHead(t) {
    if (t == null) return false;
    t = String(t).replace(/\s+$/, '');
    if (!t) return false;
    if (Array.from(t).length > 40) return false;
    return !RE_HEADPUNCT.test(t);
  }

  /* ---------- 行分类器：classify(line, ctx) ----------
     ctx 省略（探针/isChapterLine/isSectionLine）→ 不做第 3 道上下文卡，保持宽松可探。
     方案 a（规划书 v2 §3.1/§7-Q2，2026-10-21 定案）三道护栏的精确用法：
       裸题＝无条件；严格形＝①+②（不查③）；宽松形＝①+②+③；点号 dotted＝①+②（豁免③）。
     护栏③ ctx = {prevBlank, prevHead}：上一行为空/文首（prevBlank）或上一行本身是章/节标题
     （prevHead，标题链可相连）才放行宽松形；段落中间的正文句（上行为普通正文）仍被拦下。 */
  function classify(line, ctx) {
    var raw = String(line == null ? '' : line);
    var m;
    // 1 节·裸题（整行即编号+关键字，无条件）
    if ((m = RE_BARE_SEC.exec(raw))) return { kind: 'section', no: zh2num(m[1]), sub: null, title: '', rawTitle: raw };
    // 2 章·裸题
    if ((m = RE_BARE_CHAP.exec(raw))) return { kind: 'chapter', no: zh2num(m[1]), sub: null, title: '', rawTitle: raw };
    // 3 节·严格（关键字后有空白，形态本身已是强信号；不查②不查③，否则真实样本「一夜安眠…」类带省略号标题会被误判）
    if ((m = RE_STRICT_SEC.exec(raw))) return { kind: 'section', no: zh2num(m[1]), sub: null, title: m[2].replace(/\s+$/, ''), rawTitle: raw };
    // 4 章·严格
    if ((m = RE_STRICT_CHAP.exec(raw))) return { kind: 'chapter', no: zh2num(m[1]), sub: null, title: m[2].replace(/\s+$/, ''), rawTitle: raw };
    // 5 节·宽松（无空格分隔，①+②+③ 三道全用）
    if ((m = RE_LOOSE_SEC.exec(raw))) {
      if (headAllowed(m[2], ctx)) return { kind: 'section', no: zh2num(m[1]), sub: null, title: m[2].replace(/\s+$/, ''), rawTitle: raw };
    }
    // 6 章·宽松
    if ((m = RE_LOOSE_CHAP.exec(raw))) {
      if (headAllowed(m[2], ctx)) return { kind: 'chapter', no: zh2num(m[1]), sub: null, title: m[2].replace(/\s+$/, ''), rawTitle: raw };
    }
    // 7 点号编号：只当节，绝不当章；①+②，豁免③（裸点号行几乎不可能是散文句，修复无空行紧凑排版）
    if ((m = RE_DOTTED.exec(raw))) {
      if (titleLooksLikeHead(m[3])) return { kind: 'dotted', no: parseInt(m[1], 10), sub: parseInt(m[2], 10), title: m[3].replace(/\s+$/, ''), rawTitle: raw };
    }
    // 8 其余
    return { kind: 'body', title: '', rawTitle: raw };
  }
  // 宽松形护栏：②形状恒查；ctx 存在时加查③（上一行为空/文首 或 上一行本身是标题）
  function headAllowed(title, ctx) {
    if (!titleLooksLikeHead(title)) return false;
    if (ctx) return !!(ctx.prevBlank || ctx.prevHead);
    return true;   // 探针调用（ctx 省略）不卡③
  }

  function isChapterLine(line) { var k = classify(line).kind; return k === 'chapter'; }
  function isSectionLine(line) { var k = classify(line).kind; return k === 'section'; }

  // 统计"第X节"标题行数（裸题 + 严格两形）：供自动切分模式提示"可改用外部导入"
  function countSectionLines(text) {
    var lines = normalize(text).split('\n'), n = 0;
    for (var i = 0; i < lines.length; i++) {
      if (RE_BARE_SEC.test(lines[i]) || RE_STRICT_SEC.test(lines[i]) || RE_LOOSE_SEC.test(lines[i])) n++;
    }
    return n;
  }

  /* ---------- 正文拼接：joinBody（写库前 NBSP→空格、逐行裁剪首尾空白、去首尾空行） ---------- */
  function joinBody(arr) {
    var s = (arr || []).join('\n').replace(/\u00a0/g, ' ');
    var kept = s.split('\n').map(function (ln) { return ln.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''); });
    return kept.join('\n').replace(/^\s*\n+|\n+\s*$/g, '').trim();
  }

  /* ---------- 封面信息头处置（§3.5） ---------- */
  function handleFront(raw, blank, bookMeta, fm, dropped) {
    if (blank) return;   // 头区空行：不记录、不计数
    var t = raw.trim();
    if (t === '封面') { fm.push({ line: raw, action: 'dropped', reason: '封面标记行' }); dropped.metaLines++; return; }
    var m = RE_FRONTKV.exec(t);
    if (!m) {   // 无键名裸行：首个当书名，其余丢弃
      if (!bookMeta.title) { bookMeta.title = t; fm.push({ line: raw, action: 'kept', reason: '书名（裸行）' }); }
      else { fm.push({ line: raw, action: 'dropped', reason: '已有书名后的无键裸行' }); dropped.metaLines++; }
      return;
    }
    var key = m[1].replace(/[\s\u3000]/g, ''), val = m[2].trim();
    if (inSet(key, AUTHOR_KEYS) && val) { bookMeta.author = val; fm.push({ line: raw, action: 'kept', reason: '作者' }); }
    else if (inSet(key, TITLE_KEYS) && val) { bookMeta.title = val; fm.push({ line: raw, action: 'kept', reason: '书名' }); }
    else if (inSet(key, SYNOPSIS_KEYS) && val) { bookMeta.synopsis = val; fm.push({ line: raw, action: 'kept', reason: '简介' }); }
    else if (inSet(key, DROP_KEYS)) { fm.push({ line: raw, action: 'dropped', reason: '本软件无此项：' + key }); dropped.metaLines++; }
    else if (!bookMeta.title && val) { bookMeta.title = val; fm.push({ line: raw, action: 'kept', reason: '书名（首个未知键）' }); }
    else { fm.push({ line: raw, action: 'dropped', reason: '未知项：' + key }); dropped.metaLines++; }
  }

  /* ---------- 主解析：parse(text) → 树 + report（录入格式 split） ---------- */
  function parse(text) {
    var lines = normalize(text).split('\n');
    var anomalies = [], frontmatter = [], dropped = { metaLines: 0 };
    var bookMeta = { title: '', author: '', synopsis: '' };
    var chapters = [];
    var cur = null, curSec = null;
    var seenHead = false, prevBlank = true, prevHead = false;

    function newChapter(no, rawTitle, title) {
      var c = { no: no == null ? null : no, rawTitle: rawTitle || '', title: title || '', _bl: [], sections: [], _secNo: null };
      chapters.push(c);
      return c;
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var blank = /^\s*$/u.test(raw) || raw.trim() === '';
      var res = classify(raw, { prevBlank: prevBlank, prevHead: prevHead });
      var isHead = (res.kind === 'chapter' || res.kind === 'section' || res.kind === 'dotted');

      if (!seenHead && !isHead) { handleFront(raw, blank, bookMeta, frontmatter, dropped); prevBlank = blank; prevHead = false; continue; }
      if (!seenHead && isHead) seenHead = true;

      if (res.kind === 'chapter') {
        if (cur && cur.no != null && res.no != null && res.no <= cur.no) anomalies.push('章编号未递增：第' + res.no + ' 章接在第' + cur.no + ' 章后，仍按标题分章');
        cur = newChapter(res.no, res.rawTitle.trim(), res.title);
        curSec = null;   // R1/R2：新章清空当前节，节号复位不影响归属
      } else if (res.kind === 'section') {
        if (!cur) { cur = newChapter(null, '', ''); anomalies.push('首现"节"而无所属章，已自动补一章'); }
        if (cur._secNo != null && res.no != null && res.no <= cur._secNo) anomalies.push('节编号未递增：第' + res.no + ' 节，仍按标题分节');
        curSec = { no: res.no, sub: null, rawTitle: res.rawTitle.trim(), title: res.title, _bl: [] };
        cur.sections.push(curSec); cur._secNo = res.no;
      } else if (res.kind === 'dotted') {
        if (!cur) { cur = newChapter(null, '', ''); anomalies.push('首现点号编号节而无所属章，已自动补一章'); }
        if (cur.no != null && res.no !== cur.no) anomalies.push('编号 ' + res.no + '.' + res.sub + ' 与当前章号 第' + cur.no + '章 不一致，仍归入本章');
        curSec = { no: cur.no, sub: res.sub, rawTitle: res.rawTitle.trim(), title: res.title, _bl: [] };
        cur.sections.push(curSec);
      } else {   // body：R2 有节归节、无节归章（章—首节之间的正文属章本身）
        if (!blank) {
          if (curSec) curSec._bl.push(raw);
          else if (cur) cur._bl.push(raw);
        }
      }
      prevBlank = blank;
      prevHead = isHead;
    }

    // 收尾：_bl → body；空节保留（§3.5 Q4 定案：有标题无正文也保留，不静默丢）；空章保留
    var stats = { chapters: 0, sections: 0, emptyChapters: 0, emptySections: 0, words: 0 };
    var outChapters = [];
    chapters.forEach(function (c) {
      var cbody = joinBody(c._bl);
      var secs = [];
      c.sections.forEach(function (s) {
        var sbody = joinBody(s._bl);
        secs.push({ no: s.no, sub: s.sub, rawTitle: s.rawTitle, title: s.title, body: sbody });
        if (!sbody) stats.emptySections++;
        stats.words += countNonSpace(sbody);
      });
      var isEmpty = !cbody && !secs.length;
      outChapters.push({ no: c.no, rawTitle: c.rawTitle, title: c.title, body: cbody, sections: secs });
      stats.chapters++;
      if (secs.length) stats.sections += secs.length;
      if (isEmpty) stats.emptyChapters++;
      stats.words += countNonSpace(cbody);
    });

    if (!outChapters.length) anomalies.push('未识别到任何章/节标题；若要按空行分块，请改用"按章节标题自动切分"');
    if (stats.emptyChapters) anomalies.push(stats.emptyChapters + ' 个章只有标题无正文，已保留为空章');
    if (stats.emptySections) anomalies.push('保留 ' + stats.emptySections + ' 个空节（有标题无正文）');

    return {
      bookMeta: bookMeta,
      chapters: outChapters,
      report: { anomalies: anomalies, frontmatter: frontmatter, dropped: dropped, stats: stats }
    };
  }

  /* ---------- 单章录入 chapterOnly：只有章行是边界，节/点号行降级为正文原样并入所在章（不丢字） ---------- */
  function parseChapters(text) {
    var lines = normalize(text).split('\n');
    var anomalies = [], frontmatter = [], dropped = { metaLines: 0 };
    var bookMeta = { title: '', author: '', synopsis: '' };
    var chapters = [], cur = null;
    var seenHead = false, prevBlank = true, prevHead = false;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var blank = /^\s*$/u.test(raw) || raw.trim() === '';
      var res = classify(raw, { prevBlank: prevBlank, prevHead: prevHead });
      var isChap = res.kind === 'chapter';
      if (!seenHead && !isChap) { handleFront(raw, blank, bookMeta, frontmatter, dropped); prevBlank = blank; prevHead = false; continue; }
      if (!seenHead && isChap) seenHead = true;
      if (isChap) {
        cur = { no: res.no, rawTitle: res.rawTitle.trim(), title: res.title, _bl: [] };
        chapters.push(cur);
      } else if (cur && !blank) {
        // 节/点号/正文一律并入当前章 body；节标题行保留原文不丢字（用户后续可手动转节）
        cur._bl.push(raw);
      }
      prevBlank = blank; prevHead = isChap;
    }
    var stats = { chapters: 0, sections: 0, emptyChapters: 0, emptySections: 0, words: 0 };
    var outChapters = chapters.map(function (c) {
      var body = joinBody(c._bl);
      stats.chapters++; if (!body) stats.emptyChapters++;
      stats.words += countNonSpace(body);
      return { no: c.no, rawTitle: c.rawTitle, title: c.title, body: body, sections: [] };
    });
    if (!outChapters.length) anomalies.push('未识别到任何"第X章"标题，整篇将作为一章导入');
    if (stats.emptyChapters) anomalies.push(stats.emptyChapters + ' 个章只有标题无正文，已保留为空章');
    return { bookMeta: bookMeta, chapters: outChapters,
      report: { anomalies: anomalies, frontmatter: frontmatter, dropped: dropped, stats: stats } };
  }

  /* ---------- 单节录入 sectionOnly：只有节/点号行是边界，章行降级为正文并入当前节；不处理头区 ---------- */
  function parseSections(text) {
    var lines = normalize(text).split('\n');
    var anomalies = [];
    var sections = [], cur = null, lead = [];
    var prevBlank = true, prevHead = false;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var blank = /^\s*$/u.test(raw) || raw.trim() === '';
      var res = classify(raw, { prevBlank: prevBlank, prevHead: prevHead });
      var isSec = res.kind === 'section' || res.kind === 'dotted';
      if (isSec) {
        cur = { no: res.kind === 'dotted' ? res.no : res.no, sub: res.sub, rawTitle: res.rawTitle.trim(), title: res.title, _bl: [] };
        sections.push(cur);
      } else if (cur && !blank) {
        cur._bl.push(raw);   // 章行/正文一律并入当前节 body，不丢字
      } else if (!cur && !blank) {
        lead.push(raw);      // 首节之前的正文：不静默吞，预检提示
      }
      prevBlank = blank; prevHead = isSec;
    }
    var leadBody = joinBody(lead);
    if (leadBody) {
      sections.unshift({ no: null, sub: null, rawTitle: '', title: '', body: leadBody });
      anomalies.push('首节标题之前还有正文，已并入开头无题节');
    }
    var stats = { sections: 0, emptySections: 0, words: 0 };
    var out = sections.map(function (s) {
      var body = s.body != null ? s.body : joinBody(s._bl);
      stats.sections++; if (!body) stats.emptySections++;
      stats.words += countNonSpace(body);
      return { no: s.no, sub: s.sub, rawTitle: s.rawTitle, title: s.title, body: body };
    });
    if (!out.length) anomalies.push('未识别到任何"第X节"标题，无法按单节录入');
    if (stats.emptySections) anomalies.push('保留 ' + stats.emptySections + ' 个空节（有标题无正文）');
    return { sections: out, report: { anomalies: anomalies, stats: stats } };
  }

  /* ---------- txt 文件解码（§4-C-3 编码回退，纯函数 Node 可测）：UTF-8 优先，替换符过多回退 GB18030 ---------- */
  function garbledRatio(str) {
    str = String(str == null ? '' : str);
    if (!str.length) return 0;
    var n = 0;
    for (var i = 0; i < str.length; i++) if (str.charCodeAt(i) === 0xFFFD) n++;
    return n / str.length;
  }
  function decodeTxt(u8) {
    var utf8 = new TextDecoder('utf-8', { fatal: false }).decode(u8);
    if (garbledRatio(utf8) > 0.005) {
      try {
        var gb = new TextDecoder('gb18030').decode(u8);
        if (garbledRatio(gb) < garbledRatio(utf8)) return { text: gb, encoding: 'GB18030' };
      } catch (e) { /* WebView/Node 无 gb18030 标签时保持 UTF-8 结果 */ }
    }
    return { text: utf8.replace(/^\uFEFF/, ''), encoding: 'UTF-8' };
  }

  root.NOVEL_STRUCTURED_IMPORT = {
    parse: parse, parseChapters: parseChapters, parseSections: parseSections,
    classify: classify, zh2num: zh2num,
    isChapterLine: isChapterLine, isSectionLine: isSectionLine,
    countSectionLines: countSectionLines, countNonSpace: countNonSpace, normalize: normalize,
    titleLooksLikeHead: titleLooksLikeHead, joinBody: joinBody,
    garbledRatio: garbledRatio, decodeTxt: decodeTxt,
    DROP_KEYS: DROP_KEYS, TITLE_KEYS: TITLE_KEYS, AUTHOR_KEYS: AUTHOR_KEYS, SYNOPSIS_KEYS: SYNOPSIS_KEYS
  };
})(globalThis);
