/* 会话内撤回/反撤回（优化批次 F）：编辑器专用的内存双栈（undo/redo），零依赖纯逻辑，
   Node 可 new Function(src)(globalThis) 直测（见 tests/m10_undo.test.cjs）。
   范围锁定：只在当前编辑器界面、本次停留期间可撤销；栈随 writer() 闭包存亡，离开即弃，
   不落 schema/db/temp/backup，磁盘零增长（规划书 §2-F）。
   协议（调用方 views.js writer 负责喂真实状态）：
     reset(text, sel)            进编辑器设基线（清空双栈）
     current(text, sel)          打字防抖到期/任何时刻上报当前态：与基线不同→旧基线入 undo 栈（合并成一步）、清 redo
     programmaticPre(text, sel)  AI 采纳/规范文本这类“不触发 input 的程序化写回”之前调用：先冲一次 current，
                                 再把“改前态”显式入栈（写回后撤销正好回到改前）
     programmaticPost(text, sel) 写回完成后把基线更新为新态
     undo(text, sel) / redo(text, sel)  返回 {text, sel} 或 null（先冲未落栈的打字段，再弹栈；对称压入另一侧）
     canUndo([text]) / canRedo()  按钮可用性；canUndo 传当前文本时把“在打字但还没落栈”也算可撤
   栈元素 {text, sel}：text 存 stripMarkers 后的干净正文，sel 随步存取，撤销后选区不错位（§3-13）。 */
(function (root) {
  'use strict';

  function normSel(sel) {
    var s = Math.max(0, Number(sel && sel.start) || 0);
    var e = Math.max(s, Number(sel && sel.end) || 0);
    return { start: s, end: e };
  }

  function create(opts) {
    opts = opts || {};
    var max = opts.max > 0 ? opts.max : 80;   // 上限：超出丢最旧（§2-F-1）
    var U = [], R = [], snap = null;

    function pushCap(stack, st) {
      if (stack.length && stack[stack.length - 1].text === st.text) return false;   // 同文本去重，防一步要按两次撤销
      stack.push(st);
      if (stack.length > max) stack.shift();
      return true;
    }

    return {
      reset: function (text, sel) {
        U = []; R = [];
        snap = { text: String(text == null ? '' : text), sel: normSel(sel) };
      },
      // 上报当前真实态；文本与基线不同→把旧基线合并为一步历史。返回是否产生了新历史步
      current: function (text, sel) {
        var t = String(text == null ? '' : text), s = normSel(sel);
        if (snap && snap.text === t) { snap.sel = s; return false; }   // 文本没变：只跟随更新光标
        if (snap) pushCap(U, snap);
        snap = { text: t, sel: s };
        R = [];   // 新 push 时清空 redo（标准双栈语义）
        return true;
      },
      programmaticPre: function (text, sel) {
        this.current(text, sel);                        // 先把之前未落栈的打字段入栈
        if (snap) pushCap(U, { text: snap.text, sel: snap.sel });   // 再存“改前态”供撤销
        R = [];
      },
      programmaticPost: function (text, sel) {
        snap = { text: String(text == null ? '' : text), sel: normSel(sel) };
      },
      undo: function (text, sel) {
        this.current(text, sel);   // 冲掉在途打字段，保证一次撤销退到位
        if (!U.length || !snap) return null;
        R.push(snap);
        snap = U.pop();
        return snap;
      },
      redo: function (text, sel) {
        this.current(text, sel);
        if (!R.length || !snap) return null;
        pushCap(U, snap);
        snap = R.pop();
        return snap;
      },
      // canUndo 可带当前文本：正在打字但还没防抖落栈时也算“可撤”（按钮不该灰着骗人）
      canUndo: function (text) {
        if (U.length) return true;
        return text != null && snap != null && String(text) !== snap.text;
      },
      canRedo: function () { return R.length > 0; },
      sizes: function () { return { undo: U.length, redo: R.length }; }
    };
  }

  root.NOVEL_UNDO = { create: create };
})(globalThis);
