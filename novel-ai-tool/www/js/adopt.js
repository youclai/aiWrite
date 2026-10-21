/* 采纳应用（F07）：把 AI 结果按用户选的三方式作用到正文，纯字符串计算、可单测。
   - replace：用结果替换选区
   - insert ：保留原文，把结果插到选区之后（另起）
   - discard：放弃，正文不变
   任何情况下都不直接改库；返回新正文与光标位，由 UI 决定是否写回（写回前 DB 会存快照）。 */
(function (root) {
  'use strict';

  // 保守去重：模型若无视格式，把选段原样回显在结果开头（常见于润色/续写），replace 时先剥掉这段重复，
  //   避免“替换”反而把原文又塞回去一遍→看起来像另起一行新增。仅当结果开头与选区原文逐字相等才剥，绝不伤正常正文。
  function dedupEcho(res, selection) {
    var sel = String(selection == null ? '' : selection);
    if (!sel) return res;
    var lead = res.replace(/^[\s\u3000]+/, '');            // 忽略结果开头的空白/全角缩进
    if (lead.slice(0, sel.length) !== sel) return res;     // 不是逐字回显 → 不动
    var consumed = res.length - lead.length;
    return res.slice(consumed + sel.length).replace(/^[\r\n\u3000]+/, '');  // 剥掉重复原文及其后紧邻换行/缩进
  }

  // body, start, end 已假定经 clampRange 合法；result 为清洗后的 AI 文本；opts.selection 为选区原文（供 replace 去重）
  function applyResult(mode, body, start, end, result, opts) {
    opts = opts || {};
    var text = String(body == null ? '' : body);
    var res = String(result == null ? '' : result);
    var s = Math.max(0, Math.min(start || 0, text.length));
    var e = Math.max(s, Math.min(end || 0, text.length));

    if (mode === 'discard' || !res) {
      return { changed: false, newBody: text, caret: e };
    }
    if (mode === 'replace') {
      var out = dedupEcho(res, opts.selection);
      if (!out) return { changed: false, newBody: text, caret: e };   // 结果只是原文回显、剥完为空 → 视为无改动
      var nb = text.slice(0, s) + out + text.slice(e);
      return { changed: true, newBody: nb, caret: s + Array.from(out).length };
    }
    if (mode === 'insert') {
      // 保留原文：在选区末尾插入结果（前后各留一个换行避免粘连）。
      // 因 insert 本身已保留选段，若模型又把选段复述在结果开头也属冗余→同 replace 先去重，避免原文重复。
      var out2 = dedupEcho(res, opts.selection);
      if (!out2) return { changed: false, newBody: text, caret: e };   // 只是原文回显、剥完为空 → 无新内容可插
      var sep = e > 0 && text.charAt(e - 1) !== '\n' ? '\n' : '';
      var tail = text.slice(e);
      var pre = sep + out2 + (tail && tail.charAt(0) !== '\n' ? '\n' : '');
      var nb2 = text.slice(0, e) + pre + tail;
      return { changed: true, newBody: nb2, caret: e + Array.from(pre).length };
    }
    throw new Error('未知采纳方式: ' + mode);
  }

  var MODES = [
    { key: 'replace', label: '替换选区' },
    { key: 'insert', label: '插入·保留原文' },
    { key: 'discard', label: '放弃' }
  ];

  root.NOVEL_ADOPT = { applyResult: applyResult, MODES: MODES };
})(globalThis);
