// 幂等种子：确保 1 号书「test」>=2 章且都有正文；首章 >=2 节
var DB = globalThis.NOVEL_DB;
var BOOK = 1;
var chs = await DB.listChapters(BOOK);
// 补足到至少 2 章
while (chs.length < 2) {
  var nid = await DB.createChapter(BOOK, '第' + (chs.length + 1) + '章 补位');
  chs = await DB.listChapters(BOOK);
}
// 给所有空正文的章补内容
for (var i = 0; i < chs.length; i++) {
  if (!chs[i].body_len) {
    await DB.saveChapterBody(chs[i].id, '这是《test》第' + chs[i].idx + '章正文，用于走查编辑器顶栏与导出布局。风从岭上来，穿过茅草。', 'seed');
  }
}
chs = await DB.listChapters(BOOK);
var first = chs[0];
var secs = await DB.listSections(first.id);
while (secs.length < 2) {
  await DB.createSection(first.id, '第' + (secs.length + 1) + '节');
  secs = await DB.listSections(first.id);
}
for (var j = 0; j < secs.length; j++) {
  if (!secs[j].body_len) await DB.saveSectionBody(secs[j].id, '节内正文' + (j + 1) + '：老槐树下，少年转身离去，桥头脚印被风抹平。');
}
secs = await DB.listSections(first.id);
return JSON.stringify({
  chapters: chs.map(function (c) { return { id: c.id, idx: c.idx, title: c.title, wc: c.word_count }; }),
  firstChapterId: first.id,
  sections: secs.map(function (s) { return { id: s.id, idx: s.idx, title: s.title, wc: s.word_count }; })
});
