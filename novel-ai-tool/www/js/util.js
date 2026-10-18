/* 通用工具（M4）：debounce（定时器可注入以便 Node 单测）、HTML 转义、选区钳制（F11 越界兜底）、
   字节格式化、极简 id。纯函数、无 DOM 依赖。 */
(function (root) {
  'use strict';

  // 防抖：默认用全局 setTimeout；测试注入假时钟 {setTimeout, clearTimeout}
  function debounce(fn, wait, clock) {
    var c = clock || root;
    var id = null;
    function wrapper() {
      var ctx = this, args = arguments;
      if (id !== null) c.clearTimeout(id);
      id = c.setTimeout(function () { id = null; fn.apply(ctx, args); }, wait);
    }
    wrapper.cancel = function () { if (id !== null) { c.clearTimeout(id); id = null; } };
    wrapper.pending = function () { return id !== null; };
    return wrapper;
  }

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return ESC[ch]; });
  }

  // 选区钳制（F11）：任何越界/倒置都收敛到合法范围；body 变了导致选区失效时返回 valid=false
  function clampRange(start, end, len) {
    var s = Math.max(0, Math.min(Number(start) || 0, len));
    var e = Math.max(0, Math.min(Number(end) || 0, len));
    if (e < s) { var t = s; s = e; e = t; }
    return { start: s, end: e, valid: e > s };
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function countNonSpace(text) {
    var out = 0;
    Array.from(String(text || '')).forEach(function (ch) { if (!/\s/.test(ch)) out++; });
    return out;
  }

  function now() { return Date.now(); }

  /* ---------- 定位标记（F11 选区可视化）----------
     用正文罕见的全角标记符 ⟦ \u27e6 / ⟧ \u27e7 包住要处理的文字；发给 AI 前与落库前一律剥离，绝不进正文。 */
  var MARK_OPEN = '\u27e6', MARK_CLOSE = '\u27e7';

  // 删除所有标记符，返回干净正文
  function stripMarkers(raw) {
    var s = String(raw == null ? '' : raw), out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch !== MARK_OPEN && ch !== MARK_CLOSE) out += ch;
    }
    return out;
  }

  // 在干净正文的 [start,end) 前后插入标记；零宽原样返回（不加标记）
  function markSelection(clean, start, end) {
    var s = String(clean == null ? '' : clean);
    var a = Math.max(0, Math.min(Number(start) || 0, s.length));
    var b = Math.max(a, Math.min(Number(end) || 0, s.length));
    if (a === b) return s;
    return s.slice(0, a) + MARK_OPEN + s.slice(a, b) + MARK_CLOSE + s.slice(b);
  }

  // 原生选区坐标（基于可能带标记的串）→ 去标记后干净串的坐标
  function mapToClean(raw, start, end) {
    var s = String(raw == null ? '' : raw);
    var a = Math.max(0, Math.min(Number(start) || 0, s.length));
    var b = Math.max(a, Math.min(Number(end) || 0, s.length));
    function cleanIdx(pos) {
      var n = 0;
      for (var i = 0; i < pos; i++) { var ch = s.charAt(i); if (ch !== MARK_OPEN && ch !== MARK_CLOSE) n++; }
      return n;
    }
    return { start: cleanIdx(a), end: cleanIdx(b) };
  }

  // 解析标记区间：base=去标记全文，start/end=内层文字在 base 中的偏移，text=内层文字；无有效标记返回 null
  function extractMarked(raw) {
    var s = String(raw == null ? '' : raw);
    var o = s.indexOf(MARK_OPEN), c = s.lastIndexOf(MARK_CLOSE);
    if (o < 0 || c < 0 || c <= o) return null;
    var clean = '', start = -1, end = -1;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === MARK_OPEN) { if (i === o) start = clean.length; continue; }
      if (ch === MARK_CLOSE) { if (i === c) end = clean.length; continue; }
      clean += ch;
    }
    if (start < 0 || end < 0 || end < start) return null;
    return { start: start, end: end, text: clean.slice(start, end), base: clean };
  }

  root.NOVEL_UTIL = {
    debounce: debounce, escapeHtml: escapeHtml, clampRange: clampRange,
    formatBytes: formatBytes, countNonSpace: countNonSpace, now: now,
    MARK_OPEN: MARK_OPEN, MARK_CLOSE: MARK_CLOSE,
    stripMarkers: stripMarkers, markSelection: markSelection, mapToClean: mapToClean, extractMarked: extractMarked
  };
})(globalThis);
