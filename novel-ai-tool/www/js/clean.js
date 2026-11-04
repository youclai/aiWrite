/* 输出清洗（F10）：把模型回包里"非正文"的壳剥掉，只留可入稿的内容。
   规则（表驱动，Node 侧逐样本断言）：
   - 归一换行 \r\n → \n
   - 去代码围栏 ```lang 行（首/尾/裸）
   - 循环剥开头"引导语/客套话"（以下是润色结果：、好的，、当然可以…）直到不再匹配
   - 剥整段被成对包裹的外层引号（“” 「」 『』 “\" ”）
   - 首尾空白清理；段内换行与正文一律保留（不吞内容）
   保守原则：只在"确属元话术"时删除，任何可能吞正文的模式都从严不启用。

   变更 2026-11-04（「AI 执行无报错但无内容」修复之二）：
   - 标签匹配放宽容错：全角括号 ＜＞、自闭合 <正文 />、< /正文> 等写法都能确定性提取；
   - 只有"非空内层"才算命中；全空块不再被当合法正文交付（extractPair 额外给出 emptyPairOnly 供上层判异常）；
   - 交付前一律剔掉残留标记壳；
   - 导出 headSnippet() / diagnose()，把模型原始回包头部带进失败原因与日志，便于定位。 */
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
  var BODY_OPEN = '<\u6b63\u6587>', BODY_CLOSE = '</\u6b63\u6587>';   // <正文> / </正文>（规范形，供契约对齐与日志）

  /* 标签正则片段（2026-11-04）。两条硬约束：
     1) 正则元义项（\s \S \/）在片段串里必须写双反斜杠：普通字符串里 "\s" 会被 JS 源码转义吞成字面 s，
        正则静默失效（已实测踩过）；"\\s" 才落为正则的 \s。而全角括号/斜杠与“正文”写成 "\uff1c"、"\u6b63" 这类
        单反斜杠 \u 转义（字符串阶段就变成真字符，进字符类后恰好一个字符），不要把 String.raw 混进来，
        两种写法混用会多出一层转义（也已踩过）。
     2) 开/合两类靠“是否出现斜杠”硬分开，绝不写成可选 \/?，否则要么漏匹 < /正文>，要么把开标签当合标签剔掉。
     已知取舍：<正文 /> 这类自闭合写法会被当开标签，非贪婪配对只吃到下一个合标签为止。 */
  var WORD = '\u6b63\u6587';            // “正文”
  var LBR = '[<\uff1c]';                // 左括号：ASCII < 或全角 ＜
  var RBR = '[>\uff1e]';                // 右括号：ASCII > 或全角 ＞
  var SLASH = '[\\/\uff0f]';            // 斜杠：ASCII /（类内需转义）或全角 ／
  var GAP = '[\\s\\/\uff0f]*';          // 空白/斜杠任意串（标签内缝隙）
  var OPEN_SRC = LBR + '(?!\\s*' + SLASH + ')' + '\\s*' + WORD + GAP + RBR;
  var CLOSE_SRC = LBR + GAP + SLASH + GAP + WORD + '\\s*' + RBR;
  var MID_SRC = /([\s\S]*?)/.source;     // 捕获组用字面量取源，天然不吃字符串转义
  var BODY_RE = new RegExp(OPEN_SRC + MID_SRC + CLOSE_SRC, 'g');
  // 剔壳用的两个全局正则（exec/replace 都会写 lastIndex，故每次用前必置 0）
  var OPEN_RE = new RegExp(OPEN_SRC, 'g');
  var CLOSE_RE = new RegExp(CLOSE_SRC, 'g');

  // 取捕获组内层：全空白视为未命中（判 null），由调用方继续尝试其它配对或回退启发式。
  function innerNonEmpty(inner) {
    var s = String(inner == null ? '' : inner);
    return s.trim() ? s : null;
  }
  function extractDelimited(s) {
    return extractPair(String(s == null ? '' : s)).best;
  }
  /* 扫一遍所有配对，同时给出三个结论（2026-11-04）：
     - best：最长的非空内层（无则 null）；
     - anyPair：是否出现过任何配对（哪怕全空）；
     - emptyPairOnly：按格式回了配对，但所有配对全为空。模型"严格照指"回 <正文></正文> 时，
       旧行为会把空块连同周匝碎文本当合法正文交付，cleaned 非空 → session 判 ok，界面却
       "完成但无内容"。靠这个标志让上层把"只回了空标签"确定性归为可重试异常。 */
  function extractPair(s) {
    var re = new RegExp(BODY_RE.source, 'g');   // 重置 lastIndex，避免共享全局正则受上次 exec 影响
    var best = null, anyPair = false, m;
    while ((m = re.exec(s)) !== null) {
      anyPair = true;
      var inner = innerNonEmpty(m[1]);
      if (inner !== null && (best === null || inner.length > best.length)) best = inner;
      if (m.index === re.lastIndex) re.lastIndex++;   // 防零宽匹配死循环
    }
    return { best: best, anyPair: anyPair, emptyPairOnly: anyPair && best === null };
  }
  // 剪掉所有标记壳（含不成对残片）：那些标记永不属正文，逐字剔掉。
  function stripTagFragments(s) {
    OPEN_RE.lastIndex = 0;
    var out = String(s == null ? '' : s).replace(OPEN_RE, '');
    CLOSE_RE.lastIndex = 0;
    return out.replace(CLOSE_RE, '');
  }

  // 原始回包头部摘录：供失败原因与日志展示（压平空白便于单行展示，长度封顶防刷屏）
  function headSnippet(raw, n) {
    var s = normalize(raw).replace(/\s+/g, ' ').trim();
    var lim = n || 120;
    return s.length > lim ? s.slice(0, lim) + '\u2026' : s;
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
    // 优先走固定格式：命中非空 <正文>…</正文> 就只取内层（对模型偶发的越格式回显最稳）；
    //   未命中（完全没配对，或只回了全空块）才回退启发式，先剔掉标记壳再洗。
    var pair = extractPair(s);
    var core = pair.best !== null ? pair.best : stripTagFragments(s);
    core = stripFences(core);
    core = stripLead(core);
    core = stripFences(core);          // 引导语后可能又露出围栏
    core = unwrapQuotes(core);
    core = core.replace(/^\n+|\n+$/g, '');   // 去首尾空行，保留中间
    return core.trim();
  }

  /* 诊断入口（2026-11-04）：除清洗结果外，额外回答"空结果到底怎么造成的"，
     供 session 把"无报错但无内容"归为可重试异常，并把回包头部带进失败原因与日志。
     返回 { cleaned, emptyPairOnly, rawChars, head }。 */
  function diagnose(raw) {
    var s = normalize(raw);
    var pair = extractPair(s);
    return {
      cleaned: strip(s),
      emptyPairOnly: pair.emptyPairOnly,
      rawChars: Array.from(s).length,
      head: headSnippet(s)
    };
  }

  root.NOVEL_CLEAN = {
    strip: strip, headSnippet: headSnippet, diagnose: diagnose,
    _internal: {
      LEAD_PATTERNS: LEAD_PATTERNS, extractDelimited: extractDelimited, extractPair: extractPair,
      innerNonEmpty: innerNonEmpty, stripTagFragments: stripTagFragments,
      BODY_OPEN: BODY_OPEN, BODY_CLOSE: BODY_CLOSE, BODY_RE: BODY_RE,
      OPEN_SRC: OPEN_SRC, CLOSE_SRC: CLOSE_SRC
    }
  };
})(globalThis);
