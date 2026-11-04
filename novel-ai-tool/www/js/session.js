/* 写作动作引擎（M4 核心，F05–F07/F10/F11/F22 的编排）：把"选段 + 模板 → 组装 prompt → 走 provider/stream
   流式 → 清洗 → 交预览（采纳与否由 UI 决定）"串成一个无 DOM 的函数，Node 侧用假库 + mock 传输即可端到端测。

   铁律落点：
   - 结果只回 preview，绝不在此写正文；正文写回是 UI 调 NOVEL_DB.saveChapterBody 的事（那里面自动存快照）
   - auto_adopt 恒 false：本引擎不提供任何自动采纳路径
   - 失败不崩：网络/解析异常都 finishJob(failed) 并把可读原因回传，界面给重试
   - 密钥运行时从 NOVEL_SECURE 取明文注入，session 不缓存、不落盘

   变更 2026-11-04（「AI 执行无报错但无内容」修复之三）：旧链路把“清洗后为空”当成功（status ok +
   界面只一个关闭按钮），既不报错也无留痕，无法定位。现在：产出正文的动作若拿到空正文（只回了
   空标签 / 完全没回字），一律记 finishJob(failed) 并回可重试异常，同时把模型原始回包头部落到
   ai_jobs.raw_head；用户中途停止（stopped）仍按原约定交付已收片段，不归异常。 */
(function (root) {
  'use strict';

  // deps = { db, prompt, providers, stream, clean, secure }
  // p = { book, chapter, characters, settings, api:{provider,base_url,model}, template,
  //       selection:{start,end,text}, before, after, onDelta, transport, keyOverride, allowEmpty }
  function executeAction(deps, p) {
    var db = deps.db;
    var body = String(p.chapter && p.chapter.body || '');
    var sel = p.selection || {};
    var s = Math.max(0, Math.min(sel.start || 0, body.length));
    var e = Math.max(s, Math.min(sel.end || 0, body.length));
    var selectionText = sel.text != null ? sel.text : body.slice(s, e);

    // 章节被删等越界兜底（F11）
    if (p.chapter && p.chapter.__missing) {
      return Promise.resolve({ ok: false, reason: '章节已不存在，请刷新后重试' });
    }

    var built;
    try {
      built = deps.prompt.build({
        book: p.book,
        chapterSummary: p.chapter && p.chapter.summary,
        prevSummary: p.prevSummary,
        selection: selectionText,
        beforeText: p.before || '',
        afterText: p.after || '',
        matchText: body,
        characters: p.characters || [],
        template: p.template,
        userHint: p.userHint,   // 本次操作的可选补充要求（prompt.js 限长并拼进永不裁的[指令]）
        settings: p.settings
      });
    } catch (err) {
      return Promise.resolve({ ok: false, reason: '提示词组装失败：' + (err.message || err) });
    }

    var api = p.api || { provider: 'mock' };
    var jobId = null;
    // 停止（流式中断）：cancelFn 在流建立后捕获句柄；早于流建立的取消先记意图，建流即刻生效
    var cancelFn = null, cancelRequested = false, stopped = false;
    var result = Promise.resolve(db.startJob({
      book_id: p.book && p.book.id, chapter_id: p.chapter && p.chapter.id,
      kind: p.template && p.template.kind, provider: api.provider || '', model: api.model || '',
      prompt_chars: built.chars
    })).then(function (id) {
      jobId = id;
      var desc = deps.providers.describe(api);
      var keyPromise = api.provider === 'mock' || p.keyOverride === ''
        ? Promise.resolve('')
        : Promise.resolve(deps.secure && deps.secure.getSecret('api_key')).then(function (k) { return k || ''; });

      return keyPromise.then(function (key) {
        return new Promise(function (resolve, reject) {
          var settled = false;
          var handle = deps.stream.run({
            desc: desc,
            prompt: built.prompt,
            key: key,
            transport: p.transport,
            onDelta: p.onDelta,
            onDone: function (full) { if (!settled) { settled = true; resolve(full); } },
            // 流正常结束却一字未收（真服务专属分支）：归为失败，不再交空串当成功
            onEmpty: function () { if (!settled) { settled = true; reject('流式结束但未收到任何返回内容'); } },
            onError: function (reason, full) { if (!settled) { settled = true; reject(reason); } }
          });
          // 停止：取消传输后把已收到的片段当结果交付（界面可采纳部分），绝不悬挂
          cancelFn = function () {
            if (settled) return;
            settled = true; stopped = true;
            try { handle.cancel(); } catch (e) {}
            resolve(handle.text());
          };
          if (cancelRequested) cancelFn();
        });
      });
    }).then(function (raw) {
      // 统一走诊断清洗：除正文外还拿到“是否只回了空标签 / 回包头部”，用于把空结果归为可判定异常
      var diag = (deps.clean && deps.clean.diagnose) ? deps.clean.diagnose(raw)
        : { cleaned: deps.clean.strip(raw), emptyPairOnly: false, rawChars: String(raw || '').length,
            head: (deps.clean.headSnippet || String)(raw || '') };
      var cleaned = diag.cleaned;
      var outChars = Array.from(cleaned || '').length;
      var kind = (p.template && p.template.kind) || '';
      // “产出正文”的动作才施空守卫；问答/摘要这类可正当返回空的由调用方 allowEmpty 显放行
      var isContent = kind !== 'consistency' && kind !== 'query' && !p.allowEmpty;
      var emptyResult = !stopped && isContent && (!outChars || diag.emptyPairOnly);
      if (emptyResult) {
        // 控制台留一份原始回包，真机 DevTools 可直接对比“模型发了什么 / 洗掉了什么”
        try { if (root.console) root.console.warn('[session] 空结果 jobId=' + jobId + ' kind=' + kind +
          ' rawChars=' + diag.rawChars + ' rawHead=' + diag.head); } catch (e) {}
        return db.finishJob(jobId, { status: 'failed', output_chars: 0,
          error: '模型未返回可用正文（回包 ' + diag.rawChars + ' 字：' + diag.head + '）',
          raw_head: diag.head }).then(function () {
          return { ok: false, jobId: jobId, empty: true, raw: raw, rawHead: diag.head, prompt: built.prompt,
            reason: '模型未返回可用正文（可能只回了空标签或流式未收到内容），请重试或换个模型；' +
              '回包摘录：' + diag.head };
        });
      }
      return db.finishJob(jobId, { status: 'ok', output_chars: outChars,
        error: stopped ? 'stopped-by-user' : '', raw_head: diag.head }).then(function () {
        return {
          ok: true, jobId: jobId, stopped: stopped,
          prompt: built.prompt, meta: built,
          raw: raw, rawHead: diag.head, cleaned: cleaned,
          selection: { start: s, end: e, text: selectionText }
        };
      });
    }).catch(function (err) {
      // stream 的 onError 已把原因格式为字符串；其余异常兜底取 message
      var reason = typeof err === 'string' ? err
        : ((deps.providers.errorReason && deps.providers.errorReason(err)) || (err && err.message) || String(err));
      var mark = db.finishJob(jobId, { status: 'failed', output_chars: 0, error: reason }).catch(function () {});
      return Promise.resolve(mark).then(function () {
        return { ok: false, jobId: jobId, reason: reason, prompt: built.prompt };
      });
    });

    // 把取消能力挂到返回的 Promise 上：await 仍照常可用，UI 可在 resolve 前调用 .cancel()
    result.cancel = function () {
      if (cancelFn) cancelFn();
      else cancelRequested = true;
    };
    return result;
  }

  // 一致性检查（F32）：跑一次动作并解析成条目、落库；范围按 settings.check_scope
  function runConsistency(deps, p) {
    return executeAction(deps, p).then(function (res) {
      if (!res.ok) return res;
      var items = deps.consistence ? deps.consistence.parse(res.cleaned) : [];
      if (!items.length) return Object.assign(res, { issues: [] });
      return Promise.resolve(deps.db.addIssues(p.book && p.book.id, p.chapter && p.chapter.id, res.jobId, items))
        .then(function () { return Object.assign(res, { issues: items }); });
    });
  }

  root.NOVEL_SESSION = {
    executeAction: executeAction,
    runConsistency: runConsistency
  };
})(globalThis);
