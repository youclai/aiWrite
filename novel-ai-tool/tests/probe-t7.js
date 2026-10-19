// 建议7：补充要求弹层 + userHint 透传 + 查询补充框 + 内置模板文案富化（BUILTIN & DB v5）
var A = globalThis.NOVEL_APP, DB = globalThis.NOVEL_DB, V = globalThis.NOVEL_VIEWS, S = globalThis.NOVEL_SESSION;
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var vis = function (id) { var e = document.getElementById(id); return e && !!(e.closest('.sheet') ? !e.closest('.sheet').hidden : e.offsetParent); };
var log = [];

A.go('#/editor/1/7'); await wait(900);
// A. 提示弹层 UI：打开 FAB → 点“润色”
document.getElementById('fabBtn').click(); await wait(300);
log.push('fabOpen=' + !!document.querySelector('.fab-wrap.open'));
var pol = document.querySelector('.fab-item[data-kind="polish"]');
pol.click(); await wait(400);
var hintTa = document.getElementById('hintTa');
log.push('hintSheetVisible=' + !!(hintTa && hintTa.closest('.sheet') && !hintTa.closest('.sheet').hidden));
log.push('hintMaxlength=' + (hintTa && hintTa.getAttribute('maxlength')));
log.push('hintPlaceholder=' + (hintTa ? String(hintTa.placeholder).slice(0, 12) : ''));
// 取消
var cancel = [].filter.call(document.querySelectorAll('.sheet [data-closesheet]'), function (b) { return !b.closest('.sheet').hidden; })[0];
if (cancel) cancel.click(); await wait(200);

// B. userHint 透传捕获：桩 apiReady + executeAction，走“续写”（免选区）
var origReady = A.apiReady, origExec = S.executeAction, captured = '__none__';
A.apiReady = function () { return { ok: true }; };
S.executeAction = function (deps, args) { captured = args.userHint; return Promise.resolve({ ok: false, reason: 'stub' }); };
document.getElementById('fabBtn').click(); await wait(200);
var cont = document.querySelector('.fab-item[data-kind="continue"]');
cont.click(); await wait(400);
var ta2 = document.getElementById('hintTa'); ta2.value = '本次补充要求XYZ';
var go = [].filter.call(document.querySelectorAll('.sheet [data-hintgo]'), function (b) { return !b.closest('.sheet').hidden; })[0];
go.click(); await wait(500);
log.push('userHintCaptured=' + JSON.stringify(captured));
A.apiReady = origReady; S.executeAction = origExec;
var pv = document.getElementById('pv'); if (pv) pv.hidden = true;

// C. 查询补充框
document.getElementById('fabBtn').click(); await wait(200);
var qb = document.querySelector('.fab-item[data-act="query"]'); qb.click(); await wait(400);
log.push('qText=' + !!document.getElementById('qText') + ' qHint=' + !!document.getElementById('qHint') + ' qHintMax=' + (document.getElementById('qHint') || {}).getAttribute?.('maxlength'));
var qcancel = [].filter.call(document.querySelectorAll('.sheet [data-closesheet]'), function (b) { return !b.closest('.sheet').hidden; })[0];
if (qcancel) qcancel.click(); await wait(200);

// D. 内置模板文案富化：BUILTIN + DB templates(v5)
var bp = V.BUILTIN.filter(function (x) { return x.kind === 'polish'; })[0];
log.push('BUILTIN_polish_enriched=' + /只输出润色后的正文/.test(bp.instruction));
var tpls = await DB.listTemplates();
var tpol = tpls.filter(function (t) { return t.kind === 'polish' && t.is_builtin; })[0];
log.push('DB_polish_enriched=' + (tpol ? /只输出润色后的正文/.test(tpol.instruction) : 'no-row'));
var summary = tpls.filter(function (t) { return t.kind === 'summary' && t.is_builtin; })[0];
log.push('DB_summary=' + (summary ? summary.instruction.slice(0, 20) : 'no-row'));
return log.join('\n');
