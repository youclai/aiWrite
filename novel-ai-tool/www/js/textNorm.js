/* 规范文本（优化批次 E）：本地纯函数排版工——所有段落首行缩进两个全角空格、每段独占一行。
   零依赖、零 IO，Node 可 new Function(src)(globalThis) 直测（见 tests/m10_textnorm.test.cjs）。
   规则（规划书 §2-E）：
     - 分段以换行符为边界（\r\n/\r 先归一为 \n），连续空行/纯空白行丢弃；
     - 每段先剥掉行首行尾的空白/全角空格 U+3000/NBSP（清掉旧缩进，保证幂等），
       半角/制表符缩进会被统一成两个全角空格——混用半角的用户需知悉（§3-9）；
     - 段前加 '　　'（两全角空格，与界面 para_indent 口径一致），段间用单个 \n 连接；
     - 幂等：重复执行结果不变；不删任何字，纯空白/换行调整（可交给会话内撤回 F 反悔）。 */
(function (root) {
  'use strict';

  var INDENT = '\u3000\u3000';   // 两个全角空格
  // 行首/行尾要剥掉的空白字符集：\s 在 JS 正则里已含 U+3000 与 NBSP，显式写上以防引擎差异
  function trimEdge(s) { return s.replace(/^[\s\u3000\u00a0]+|[\s\u3000\u00a0]+$/g, ''); }

  // normalize(text) → { text, count }：count 为规范后的非空段数（0 表示整篇无有效内容）
  function normalize(text) {
    var t = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var paras = [];
    t.split('\n').forEach(function (line) {
      var s = trimEdge(line);
      if (s !== '') paras.push(INDENT + s);   // 空段丢弃；有效段统一加两全角缩进
    });
    return { text: paras.join('\n'), count: paras.length };
  }

  root.NOVEL_TEXT_NORM = { normalize: normalize, INDENT: INDENT };
})(globalThis);
