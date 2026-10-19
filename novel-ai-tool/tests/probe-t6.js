// 建议6：并入现有书籍——预检(追加数+重名提示) → 确认 → 落库校验（旧章不变，末尾追加）
var A = globalThis.NOVEL_APP, DB = globalThis.NOVEL_DB;
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var log = [];
var before = await DB.listChapters(1);
log.push('before count=' + before.length + ' titles=' + JSON.stringify(before.map(function (c) { return c.title; })));

A.go('#/me/import'); await wait(800);
var mergeR = document.querySelector('input[name="impMode"][value="merge"]');
mergeR.checked = true; mergeR.dispatchEvent(new Event('change')); await wait(300);
log.push('fldBook visible=' + !document.getElementById('fldBook').hidden);
var sel = document.getElementById('impBook'); sel.value = '1'; sel.dispatchEvent(new Event('change')); await wait(500);
log.push('bookStat=' + (document.getElementById('bookStat') || {}).textContent);

var text = '第一章 起风\n这里是重复标题的正文内容测试段落。\n\n第九十九章 新峰\n这里是全新章节的正文内容测试段落。';
var bodyEl = document.getElementById('impBody'); bodyEl.value = text; bodyEl.dispatchEvent(new Event('input')); await wait(100);

document.getElementById('preCheckBtn').click();
var sheet;
for (var i = 0; i < 15; i++) {
  await wait(300);
  sheet = [].filter.call(document.querySelectorAll('.sheet'), function (s) { return !s.hidden && /导入预检/.test(s.textContent); })[0];
  if (sheet) break;
}
if (!sheet) return 'NO precheck sheet. ' + log.join(' || ');
log.push('precheckHasAppend=' + /追加\s*2\s*章/.test(sheet.textContent));
log.push('precheckHasDup=' + /重名/.test(sheet.textContent));
log.push('doImportEnabledAfterPrecheck=' + !document.getElementById('doImport').disabled);

var ok = sheet.querySelector('[data-icok]');
ok.click();
// 等导航到书章节页
for (var j = 0; j < 20; j++) { await wait(300); if (/^#\/book\/1\/chapters/.test(location.hash)) break; }
log.push('hashAfterImport=' + location.hash);

var after = await DB.listChapters(1);
log.push('after count=' + after.length);
log.push('after titles=' + JSON.stringify(after.map(function (c) { return { idx: c.idx, t: c.title }; })));
var origKept = before.every(function (b, i) { return after[i] && after[i].id === b.id && after[i].title === b.title; });
log.push('originalChaptersUnchanged=' + origKept);
log.push('appendedTitles=' + JSON.stringify(after.slice(before.length).map(function (c) { return c.title; })));
return log.join('\n');
