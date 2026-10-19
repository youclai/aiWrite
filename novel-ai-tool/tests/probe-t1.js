// 建议1：标题(.sec-head) 与 操作按钮(.sec-actions) 上下结构 + 按钮热区>=40px
var A = globalThis.NOVEL_APP;
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
function measure(tag) {
  var head = document.querySelector('.sec-head');
  var acts = document.querySelector('.sec-actions');
  if (!head || !acts) return tag + ': MISSING head=' + !!head + ' acts=' + !!acts;
  var hr = head.getBoundingClientRect(), ar = acts.getBoundingClientRect();
  var stacked = ar.top >= hr.bottom - 2; // 操作区在标题下方
  var btns = [].map.call(acts.querySelectorAll('button'), function (b) {
    var r = b.getBoundingClientRect(); return Math.round(r.height);
  });
  var minH = btns.length ? Math.min.apply(null, btns) : 0;
  return tag + ': stacked=' + stacked + ' (headBottom=' + Math.round(hr.bottom) + ',actsTop=' + Math.round(ar.top) + ') btnHeights=' + JSON.stringify(btns) + ' minH=' + minH + (minH >= 40 ? ' OK' : ' TOO-SMALL');
}
var out = [];
A.go('#/book/1/chapters'); await wait(800);
out.push(measure('bookChapters'));
A.go('#/chapter/7'); await wait(800);
out.push(measure('chapterDetail'));
return out.join('\n');
