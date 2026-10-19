// 直接调用 JS 侧 onBack()，验证逻辑本身（绕开原生返回键接线）
var A = globalThis.NOVEL_APP;
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
A.go('#/chapter/7'); await wait(800);
var before = location.hash;
A.onBack(); await wait(600);
var after1 = location.hash;
A.onBack(); await wait(600);
var after2 = location.hash;
return JSON.stringify({ before: before, afterBack1: after1, afterBack2: after2 });
