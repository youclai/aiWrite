/* 一致性检查报告解析（F32，升 P0）：把模型回的"排查结果"归一成条目数组。
   三级降级（格式越坏越要保住结果，绝不整批丢）：
     1) 整体当 JSON 解析（数组或 {issues:[...]}）
     2) 正则抠出首个平衡的 [ ... ] 再当 JSON 解析
     3) 按行切纯文本，每非空行当一条 problem
   字段归一：quote / type / problem / suggestion，缺失给安全默认；problem 空的条目丢弃。 */
(function (root) {
  'use strict';

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  function normalizeItem(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') {
      var t = raw.trim();
      return t ? { quote: '', type: '', problem: t, suggestion: '' } : null;
    }
    var problem = pick(raw, ['problem', '问题', 'issue', 'desc', 'description']);
    if (!problem) return null;   // 无问题描述不入库
    return {
      quote: pick(raw, ['quote', '原文', '引用', 'text', 'evidence']),
      type: pick(raw, ['type', '类型', 'category', 'kind']),
      problem: problem,
      suggestion: pick(raw, ['suggestion', '建议', 'fix', 'advice', '推荐'])
    };
  }

  function fromArray(arr) {
    var out = [];
    (arr || []).forEach(function (it) {
      var n = normalizeItem(it);
      if (n) out.push(n);
    });
    return out;
  }

  // 尝试把任意 JSON（数组 / {issues} / {结果} / 单对象）转成数组
  function coerceJson(obj) {
    if (Array.isArray(obj)) return obj;
    if (obj && typeof obj === 'object') {
      var arrKeys = ['issues', '结果', '问题', 'items', 'data', 'list'];
      for (var i = 0; i < arrKeys.length; i++) {
        if (Array.isArray(obj[arrKeys[i]])) return obj[arrKeys[i]];
      }
      return [obj];   // 单条对象
    }
    return null;
  }

  // 在文本里找首个方括号包围的 JSON 数组（按括号配平，忽略字符串内的括号）
  function extractFirstArray(text) {
    var s = String(text || '');
    var start = s.indexOf('[');
    if (start < 0) return null;
    var depth = 0, inStr = false, esc = false, quote = '';
    for (var i = start; i < s.length; i++) {
      var ch = s.charAt(i);
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === quote) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
    return null;
  }

  function parseLineText(rawText) {
    return String(rawText || '').split(/\r?\n/)
      .map(function (l) { return l.replace(/^[\s\-*·•\d.、)）]+/, '').trim(); })   // 去行首项目符号/编号
      .filter(function (l) { return l.length >= 4; })                                // 过滤过短噪声行
      .map(function (l) { return { quote: '', type: '', problem: l, suggestion: '' }; });
  }

  // 主入口：rawText（模型原始输出，可能含前后废话）→ 条目数组
  function parse(rawText) {
    var text = String(rawText == null ? '' : rawText).trim();
    if (!text) return [];

    // 级 1：整体 JSON（解析成功即视为结构化结果，哪怕合法条目为 0，也不再降级成文本噪声）
    try {
      var whole = JSON.parse(text);
      var arr1 = coerceJson(whole);
      if (arr1) return fromArray(arr1);
    } catch (e) { /* 降级 */ }

    // 级 2：抠首个 [...] 再 JSON（同理：抠出且能解析为数组即返回）
    var frag = extractFirstArray(text);
    if (frag) {
      try {
        var arr2 = coerceJson(JSON.parse(frag));
        if (Array.isArray(arr2)) return fromArray(arr2);
      } catch (e) { /* 降级 */ }
    }

    // 级 3：按行切纯文本
    return parseLineText(text);
  }

  root.NOVEL_CONSISTENCE = {
    parse: parse,
    normalizeItem: normalizeItem,
    extractFirstArray: extractFirstArray,
    parseLineText: parseLineText
  };
})(globalThis);
