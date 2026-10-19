// 建议3：编辑器顶栏 .chbar 内 .tin 与 .chbar-meta 同行且不重叠、无横向溢出
var A = globalThis.NOVEL_APP;
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
A.go('#/editor/1/7'); await wait(900);
var bar = document.querySelector('.chbar');
var tin = document.querySelector('.chbar .tin');
var meta = document.querySelector('.chbar-meta');
if (!bar || !tin || !meta) return 'MISSING bar=' + !!bar + ' tin=' + !!tin + ' meta=' + !!meta;
var br = bar.getBoundingClientRect(), tr = tin.getBoundingClientRect(), mr = meta.getBoundingClientRect();
var sameRow = !(tr.bottom <= mr.top || mr.bottom <= tr.top); // 垂直区间有交叠=同一行
var noOverlap = tr.right <= mr.left + 1; // 标题不压到元信息组
var metaInside = mr.right <= br.right + 1 && mr.left >= br.left - 1;
var parts = ['.wc', '.save', '#verBtn'].map(function (s) { return s + '=' + (document.querySelector('.chbar ' + s) ? 'y' : 'N'); });
return JSON.stringify({
  sameRow: sameRow, noOverlap: noOverlap, metaInsideBar: metaInside,
  tinRight: Math.round(tr.right), metaLeft: Math.round(mr.left), metaRight: Math.round(mr.right), barRight: Math.round(br.right),
  metaParts: parts.join(','),
  barScrollOverflow: bar.scrollWidth > bar.clientWidth ? 'OVERFLOW(' + bar.scrollWidth + '>' + bar.clientWidth + ')' : 'none'
});
