/* 输出清洗（F10）：把模型回包里"非正文"的壳剥掉，只留可入稿的内容。
   规则（表驱动，Node 侧逐样本断言）：
   - 归一换行 \r\n → \n
   - 去代码围栏 ```lang 行（首/尾/裸）
   - 循环剥开头"引导语/客套话"（以下是润色结果：、好的，、当然可以…）直到不再匹配
   - 剥整段被成对包裹的外层引号（“” 「」 『』 “\" ”）
   - 首尾空白清理；段内换行与正文一律保留（不吞内容）
   保守原则：只在"确属元话术"时删除，任何可能吞正文的模式都从严不启用。 */
(function (root) {
  'use strict';

  // 开头元话术：每条从字符串首部匹配一次，命中即剥掉再重试（可叠加多行客套）
  var LEAD_PATTERNS = [
    /^\s*(?:好的|当然(?:可以)?|没问题|不客气|明白(?:了)?|收到)[，,、。.！!：:\s]+/,
    /^\s*(?:以下是|下面是|这是|接下来的?|以下为)[^\n]{0,40}?[结果内容文本改写润色扩写缩写续写摘要翻译]{0,6}[：:]\s*\n?/,
    /^\s*(?:我(?:已经|已|为你|帮您?|帮你)?)[^\n]{0,30}?(?:完成|润色|改写|扩写|缩写|整理|处理)[^\n]{0,20}?[：:.。]\s*\n?/
  ];

  // 成对包裹外层引号：首尾同时命中同一对才剥
  var WRAP_PAIRS = [
    ['\u201c', '\u201d'], // “ ”
    ['\u300c', '\u300d'], // 「 」
    ['\u300e', '\u300f'], // 『 』
    ['"', '"'],
    ["'", "'"]
  ];

  /* 固定输出契约（与 prompt.js 的 [输出格式] 对齐）：模型把结果正文包在 <正文>…</正文> 之间。
     命中则确定性只取标记内内容（天然剔除客套话/回显的选段原文/外层解释）；未命中则回退下面的启发式清洗。 */
  var BODY_OPEN = '<\u6b63\u6587>', BODY_CLOSE = '</\u6b63\u6587>';   // <正文> / </正文>
  // 全局非贪婪扫描所有配对：取内容最长的一个。这样若模型先照拄了规则里的空模板
  // <正文></正文>（或先输出一段带标签的废话）也不会误命中空块而丢真正文；无任何配对才回退启发式。
  var BODY_RE = /<\u6b63\u6587>([\s\S]*?)<\/\u6b63\u6587>/g;   // 正则字面量：\s\S 天然生效（勿用字符串拼 new RegExp）
  function extractDelimited(s) {
    var re = new RegExp(BODY_RE.source, 'g');   // 重置 lastIndex，避免共享全局正则受上次 exec 影响
    var best = null, m;
    while ((m = re.exec(String(s == null ? '' : s))) !== null) {
      if (best === null || m[1].length > best.length) best = m[1];
      if (m.index === re.lastIndex) re.lastIndex++;   // 防零宽匹配死循环
    }
    return best;
  }

  function normalize(text) {
    var s = String(text == null ? '' : text);
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return s;
  }

  function stripFences(s) {
    // 首部围栏
    s = s.replace(/^\s*```[a-zA-Z0-9_-]*[ \t]*\n?/, '');
    // 尾部围栏
    s = s.replace(/\n?[ \t]*```[ \t]*$/, '');
    return s;
  }

  function stripLead(s) {
    var changed = true, guard = 0;
    while (changed && guard++ < 12) {
      changed = false;
      for (var i = 0; i < LEAD_PATTERNS.length; i++) {
        var m = s.match(LEAD_PATTERNS[i]);
        if (m && m.index === 0) { s = s.slice(m[0].length); changed = true; }
      }
    }
    return s;
  }

  function unwrapQuotes(s) {
    var t = s.trim();
    for (var i = 0; i < WRAP_PAIRS.length; i++) {
      var p = WRAP_PAIRS[i];
      if (t.length >= 2 && t.charAt(0) === p[0] && t.charAt(t.length - 1) === p[1]) {
        return t.slice(1, t.length - 1).trim();
      }
    }
    return s;
  }

  // 主入口：raw → 清洗后的可入稿文本
  function strip(raw) {
    var s = normalize(raw);
    // 优先走固定格式：命中 <正文>…</正文> 就只取内层（对模型偶发的越格式回显最稳）；未命中才回退启发式
    var inner = extractDelimited(s);
    var core = inner != null ? inner : s;
    core = stripFences(core);
    core = stripLead(core);
    core = stripFences(core);          // 引导语后可能又露出围栏
    core = unwrapQuotes(core);
    core = core.replace(/^\n+|\n+$/g, '');   // 去首尾空行，保留中间
    return core.trim();
  }

  root.NOVEL_CLEAN = { strip: strip, _internal: { LEAD_PATTERNS: LEAD_PATTERNS, extractDelimited: extractDelimited, BODY_OPEN: BODY_OPEN, BODY_CLOSE: BODY_CLOSE } };
})(globalThis);
