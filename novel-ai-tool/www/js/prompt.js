/* 提示词组装 + 五级裁剪（F20–F24）：把"选段 + 上下文 + 设定 + 角色卡 + 指令"拼成最终 prompt，
   并在超预算时按固定优先级逐级裁剪，且保证每轮真的减下长度（防死循环）。
   纯函数、无 IO，输入是调用方从 NOVEL_DB 取好并预处理过的数据，Node 侧可全部单测。

   裁剪优先级（超预算时依次动，选段与指令永不裁）：
     作品设定 → 本章摘要 → 角色卡 → 前文 → 后文
   前文/后文先按段截断、截到只剩 1 段仍超才整块丢弃；丢弃/截断都会记录 trimmed 明细。 */
(function (root) {
  'use strict';

  // 粗估 token：非空白字符数 × 0.75 向上取整（CJK 偏高的保守启发式，仅用于裁剪阈值判断，不追求精确）
  function estimateTokens(text) {
    var n = 0;
    Array.from(String(text || '')).forEach(function (ch) { if (!/\s/.test(ch)) n++; });
    return Math.ceil(n * 0.75);
  }

  function paragraphs(text) {
    return String(text || '').split(/\n{2,}|\n/).map(function (p) { return p.trim(); }).filter(Boolean);
  }
  function joinParas(arr) { return arr.join('\n\n'); }

  function countHits(haystack, needle) {
    if (!needle) return 0;
    var c = 0, i = 0, h = String(haystack || ''), n = String(needle);
    while ((i = h.indexOf(n, i)) >= 0) { c++; i += n.length; }
    return c;
  }

  // F21 角色卡命中：按 name+aliases 子串在 matchText 出现频次排序，取前 5
  function matchCharacters(chars, matchText, limit) {
    var max = limit || 5;
    var scored = (chars || []).map(function (c) {
      var names = [c.name].concat(c.aliases || []).filter(function (x) { return x && String(x).length; });
      var freq = 0;
      names.forEach(function (n) { freq += countHits(matchText, n); });
      return { c: c, freq: freq };
    }).filter(function (x) { return x.freq > 0; })
      .sort(function (a, b) { return b.freq - a.freq; })
      .slice(0, max);
    return scored.map(function (x) { return x.c; });
  }

  function formatCharacter(c, injectTaboos) {
    var lines = ['- ' + c.name + (c.role ? '（' + c.role + '）' : '')];
    if (c.aliases && c.aliases.length) lines.push('  别名：' + c.aliases.join('、'));
    if (c.personality) lines.push('  性格：' + c.personality);
    if (c.speech_style) lines.push('  说话风格：' + c.speech_style);
    if (injectTaboos && c.taboos) lines.push('  禁忌：' + c.taboos);
    return lines.join('\n');
  }

  // ctx = {
  //   book:{synopsis,style_note}, chapterSummary, prevSummary,
  //   selection, beforeText, afterText, matchText, characters:[...],
  //   template:{name,instruction,use_summary},
  //   settings:{use_summary,inject_taboos,inject_prev_summary,token_budget,prev_paras,next_paras}
  // }
  function build(ctx) {
    ctx = ctx || {};
    var st = ctx.settings || {};
    var budget = st.token_budget || 6000;
    var prevParas = st.prev_paras || 3;
    var nextParas = st.next_paras || 3;
    var trimmed = [], dropped = [];

    var selection = String(ctx.selection || '');
    var instruction = (ctx.template && ctx.template.instruction) || '按要求处理下文。';

    // 各可选层（携带裁剪元数据）
    var useSummary = st.use_summary && ctx.template && ctx.template.use_summary !== undefined
      ? (ctx.template.use_summary || st.use_summary) : st.use_summary;   // 模板级覆盖：模板要求带摘要则带
    var layers = {};

    var settingText = '';
    if (ctx.book && (ctx.book.synopsis || ctx.book.style_note)) {
      var sp = [];
      if (ctx.book.synopsis) sp.push('简介：' + ctx.book.synopsis);
      if (ctx.book.style_note) sp.push('文风约定：' + ctx.book.style_note);
      settingText = sp.join('\n');
    }
    layers.setting = { text: settingText, removable: true };

    var summaryText = useSummary && ctx.chapterSummary ? ('本章摘要：' + ctx.chapterSummary) : '';
    if (useSummary && !ctx.chapterSummary) dropped.push('summary-absent');   // F31 延后：无源不报错
    layers.summary = { text: summaryText, removable: true };

    if (st.inject_prev_summary && ctx.prevSummary) {
      layers.prevSummary = { text: '上一章摘要：' + ctx.prevSummary, removable: true };
    }

    var matched = matchCharacters(ctx.characters, ctx.matchText || (selection + '\n' + (ctx.beforeText || '') + '\n' + (ctx.afterText || '')));
    var charText = matched.length
      ? matched.map(function (c) { return formatCharacter(c, st.inject_taboos); }).join('\n')
      : '';
    layers.characters = { text: charText, removable: true, _count: matched.length };

    var beforeArr = paragraphs(ctx.beforeText).slice(-prevParas);
    layers.before = { paras: beforeArr, removable: true, truncatable: true, head: false };

    var afterArr = paragraphs(ctx.afterText).slice(0, nextParas);
    layers.after = { paras: afterArr, removable: true, truncatable: true, head: true };

    // 渲染：把层拼成完整 prompt；selection 与 instruction 永远在
    function layerBody(layer) {
      if (layer.truncatable) return joinParas(layer.paras || []);
      return layer.text || '';
    }
    function render() {
      var blocks = [];
      function push(label, layer) {
        var body = layerBody(layer);
        if (!layer.removed && body) blocks.push('[' + label + ']\n' + body);
      }
      push('作品设定', layers.setting);
      push('本章摘要', layers.summary);
      if (layers.prevSummary) push('上一章摘要', layers.prevSummary);
      push('角色卡', layers.characters);
      push('前文', layers.before);
      var sel = selection ? '[需要处理的内容]\n' + selection : '[需要处理的内容]\n';
      push('后文', layers.after);
      blocks.push('[指令]\n' + instruction);
      // selection 固定放在指令前、后文之后
      blocks.splice(blocks.length - 1, 0, sel);
      return blocks.join('\n\n');
    }

    // 裁剪循环：优先级顺序，每步必须严格减长度；某层为空没减下去则继续看下一层
    var PRIORITY = ['setting', 'summary', 'prevSummary', 'characters', 'before', 'after'];
    var LABEL = { setting: '作品设定', summary: '本章摘要', prevSummary: '上一章摘要', characters: '角色卡', before: '前文', after: '后文' };
    var guard = 0;
    var prompt = render();
    while (estimateTokens(prompt) > budget && guard++ < 200) {
      var before = prompt;
      var acted = false;
      for (var i = 0; i < PRIORITY.length; i++) {
        var key = PRIORITY[i], L = layers[key];
        if (!L || L.removed) continue;
        if (L.truncatable) {
          if ((L.paras || []).length > 1) {
            L.paras = L.head ? L.paras.slice(0, L.paras.length - 1) : L.paras.slice(1);
            if (render() !== before) trimmed.push(LABEL[key] + '·截段');
          } else {
            L.removed = true;
            if (layerBody(L) || (L.paras || []).length) trimmed.push(LABEL[key] + '·整块丢弃');
          }
        } else {
          var had = !!layerBody(L);
          L.removed = true;
          if (had) trimmed.push(LABEL[key] + '·整块丢弃');
        }
        var np = render();
        if (np !== before) { prompt = np; acted = true; break; }   // 真的减了才停，否则试下一层
      }
      if (!acted) { dropped.push('over-budget-locked'); break; }   // 只剩选段+指令仍超：选段永不裁，打住
    }

    return {
      prompt: prompt,
      chars: Array.from(prompt).length,
      estTokens: estimateTokens(prompt),
      budget: budget,
      matchedCharacters: matched.map(function (c) { return c.name; }),
      trimmed: trimmed,
      dropped: dropped,
      locked: dropped.indexOf('over-budget-locked') >= 0
    };
  }

  root.NOVEL_PROMPT = {
    build: build,
    estimateTokens: estimateTokens,
    matchCharacters: matchCharacters,
    paragraphs: paragraphs
  };
})(globalThis);
