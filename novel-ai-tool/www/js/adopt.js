/* 采纳应用（F07）：把 AI 结果按用户选的三方式作用到正文，纯字符串计算、可单测。
   - replace：用结果替换选区
   - insert ：保留原文，把结果插到选区之后（另起）
   - discard：放弃，正文不变
   任何情况下都不直接改库；返回新正文与光标位，由 UI 决定是否写回（写回前 DB 会存快照）。 */
(function (root) {
  'use strict';

  // body, start, end 已假定经 clampRange 合法；result 为清洗后的 AI 文本
  function applyResult(mode, body, start, end, result) {
    var text = String(body == null ? '' : body);
    var res = String(result == null ? '' : result);
    var s = Math.max(0, Math.min(start || 0, text.length));
    var e = Math.max(s, Math.min(end || 0, text.length));

    if (mode === 'discard' || !res) {
      return { changed: false, newBody: text, caret: e };
    }
    if (mode === 'replace') {
      var nb = text.slice(0, s) + res + text.slice(e);
      return { changed: true, newBody: nb, caret: s + Array.from(res).length };
    }
    if (mode === 'insert') {
      // 保留原文：在选区末尾插入结果（前后各留一个换行避免粘连）
      var sep = e > 0 && text.charAt(e - 1) !== '\n' ? '\n' : '';
      var tail = text.slice(e);
      var pre = sep + res + (tail && tail.charAt(0) !== '\n' ? '\n' : '');
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
