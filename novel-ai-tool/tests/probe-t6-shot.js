// 只走到预检弹层（不确认），截图
var A = globalThis.NOVEL_APP;
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
A.go('#/me/import'); await wait(700);
var mergeR = document.querySelector('input[name="impMode"][value="merge"]');
mergeR.checked = true; mergeR.dispatchEvent(new Event('change')); await wait(300);
var sel = document.getElementById('impBook'); sel.value = '1'; sel.dispatchEvent(new Event('change')); await wait(400);
var bodyEl = document.getElementById('impBody');
bodyEl.value = '第一章 起风\n重复标题的正文。\n\n第一百章 悬念\n全新章节正文。';
bodyEl.dispatchEvent(new Event('input')); await wait(100);
document.getElementById('preCheckBtn').click();
for (var i = 0; i < 12; i++) { await wait(300); if (([].filter.call(document.querySelectorAll('.sheet'), function (s) { return !s.hidden && /导入预检/.test(s.textContent); })).length) break; }
return 'precheck shown';
