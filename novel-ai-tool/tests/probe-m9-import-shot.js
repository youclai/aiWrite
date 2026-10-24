// v322 外部导入目视（规划书 v2）：展示三种录入格式单选，切到「单节录入」揭示书→章两级下拉
var A = globalThis.NOVEL_APP;
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
A.go('#/me/import'); await wait(800);
var sr = [].slice.call(document.querySelectorAll('input[name="impFmt"]')).filter(function (r) { return r.value === 'sectionOnly'; })[0];
if (sr) { sr.checked = true; sr.dispatchEvent(new Event('change', { bubbles: true })); }
await wait(400);
var radios = [].slice.call(document.querySelectorAll('input[name="impFmt"]')).map(function (r) { return r.value; }).join(',');
return 'switched=' + !!sr + ' radios=' + radios;
