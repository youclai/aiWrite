/* 草稿守卫（F53 返回键保存 / F54 切后台不丢稿的公共内核）：把编辑器里"打字→防抖落盘→切页/切后台/返回前强制 flush"
   这段易错的异步协调抽成单一可注入实现，替换原先散落在 views 的临时 debounce+commit。
   与逻辑件同构——不碰 DOM、不持有 DB，全靠注入：
     opts.save(body) -> Promise<n>     真正落盘（App 端 = DB.saveChapterDraft，返回字数）
     opts.debounce                       防抖窗口 ms（默认 800；<=0 表示不防抖，mark 需靠外部主动 flush）
     opts.setTimer/clearTimer            可注入定时器（Node 测试用假时钟；默认全局 setTimeout/clearTimeout）
     opts.onState({saving|saved|dirty|error})  界面回调（更新"保存中/已保存/未保存"等；异常吞掉不外泄）
   三条硬保证（tests/m6_guard.test.cjs 逐条断言）：
     1) 单飞：同一时刻至多一个在途 save；flushNow 并发调用合并到同一 promise，绝不双写；
     2) 续存：在途期间用户又改，落盘完成后自动用最新值再存一次（不丢最后一次编辑）；
     3) 保脏：save 失败不清 dirty，下次触发（打字/切页/切后台）自动重试，成功才清。 */
(function (root) {
  'use strict';

  function n(v) { return Number(v) || 0; }

  function create(opts) {
    opts = opts || {};
    var save = opts.save;
    if (typeof save !== 'function') throw new Error('draftGuard 需要 opts.save(body) -> Promise');
    var debounceMs = opts.debounce == null ? 800 : opts.debounce;
    var setTimer = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = opts.clearTimer || function (id) { return clearTimeout(id); };
    var onState = typeof opts.onState === 'function' ? opts.onState : null;

    var dirty = false, value = '', timer = null, running = null;

    function notify(st) { if (onState) { try { onState(st); } catch (e) { /* 界面回调绝不影响存稿 */ } } }

    function schedule() {
      if (timer != null || debounceMs <= 0) return;   // 已在窗口内 / 关防抖则交给主动 flush
      timer = setTimer(function () { timer = null; pump(); }, debounceMs);
    }
    function cancel() { if (timer != null) { clearTimer(timer); timer = null; } }

    // 落盘引擎：串行、单飞、在途改动续存
    function pump() {
      if (running) return running;                     // 已有在途：合并，不另开发
      if (!dirty) return Promise.resolve({ saved: false, reason: 'clean' });
      var payload = value;
      notify({ saving: true });
      running = Promise.resolve().then(function () { return save(payload); });
      return running.then(
        function (res) {
          running = null;
          if (dirty && value !== payload) return pump();   // 在途期间又改了 → 用最新值再存
          dirty = false;
          var words = n(res);
          notify({ saved: true, words: words });
          return { saved: true, words: words };
        },
        function (err) {
          running = null;
          notify({ error: err, saved: false });
          if (dirty && value !== payload) return pump();   // 出错但有新值：仍继续尝试最新
          return { saved: false, error: err };             // 保脏，等下次触发重试
        }
      );
    }

    var guard = {
      // 记录一次编辑并重排防抖；返回自身便于链式
      mark: function (v) {
        value = v == null ? '' : String(v);
        dirty = true;
        notify({ dirty: true });
        schedule();
        return guard;
      },
      flushNow: function () { cancel(); return pump(); },   // 切页/切后台/返回键前强制落盘
      onHidden: function () { return pump(); },             // 由 visibilitychange/pause 触发
      isDirty: function () { return dirty; },
      hasPending: function () { return running != null || timer != null; },
      value: function () { return value; },
      // 关防抖定时器 + 尽力落盘；视图销毁/重进前调用
      dispose: function () { cancel(); var p = running; return p || Promise.resolve({ saved: false, reason: 'disposed' }); },
      // 绑定页面可见性：隐藏即 flushNow（注入 document，Node 测试可传假对象）；返回解绑函数
      bindVisibility: function (doc) {
        var d = doc || root.document;
        if (!d || typeof d.addEventListener !== 'function') return function () {};
        var h = function () { if (d.hidden) guard.onHidden(); };
        d.addEventListener('visibilitychange', h);
        return function () { d.removeEventListener('visibilitychange', h); };
      }
    };
    return guard;
  }

  root.NOVEL_DRAFT_GUARD = { create: create };
})(globalThis);
