// 读取当前路由 / 可见覆盖层 / 提示条文本，用于返回键走查
var hash = location.hash;
var sheets = [].filter.call(document.querySelectorAll('.sheet'), function (s) { return !s.hidden; });
var toast = document.getElementById('toast');
var toastShow = toast && /(^| )show( |$)/.test(toast.className) ? toast.textContent : '';
var fabOpen = !!document.querySelector('.fab-wrap.open');
var pv = document.querySelector('.preview');
return JSON.stringify({ hash: hash, openSheets: sheets.length, fabOpen: fabOpen, previewOpen: !!(pv && !pv.hidden), toast: toastShow });
