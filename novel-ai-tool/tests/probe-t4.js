// 建议4：导出成功弹层——落点说明 + 分享/复制/知道了 按钮
var A = globalThis.NOVEL_APP;
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
A.go('#/book/1/chapters'); await wait(900);
var eb = document.getElementById('exportBtn');
if (!eb) return 'NO exportBtn';
eb.click(); await wait(500);
var opt = document.querySelector('.sheet li[data-fmt="txt"]');
if (!opt) return 'NO txt option in export sheet';
opt.click();
// 等导出完成（原生 Filesystem 写盘 + showExportDone）
var done = false;
for (var i = 0; i < 20; i++) {
  await wait(400);
  var sheet = [].filter.call(document.querySelectorAll('.sheet'), function (s) { return !s.hidden; })[0];
  if (sheet && /导出成功/.test(sheet.textContent)) { done = true; break; }
}
var sheet = [].filter.call(document.querySelectorAll('.sheet'), function (s) { return !s.hidden; })[0];
if (!done || !sheet) return 'EXPORT sheet not shown. lastToast=' + (document.getElementById('toast') || {}).textContent;
var txt = sheet.textContent;
return JSON.stringify({
  hasTitle: /导出成功/.test(txt),
  hasLanding: /应用私有目录/.test(txt) && /temp/.test(txt) && /export/.test(txt),
  hasFiles: sheet.querySelectorAll('.list .card').length,
  btnShare: !!sheet.querySelector('[data-exshare]'),
  btnCopy: !!sheet.querySelector('[data-excopy]'),
  btnKnow: !!sheet.querySelector('[data-closesheet]'),
  snippet: txt.slice(0, 120)
});
