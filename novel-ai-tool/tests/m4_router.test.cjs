/* m4_router.test.cjs —— 路由解析回归（真机踩过的坑：#/shelf、#/me 无 params 字段，
   旧代码对 undefined 调 .forEach 抛错，render 在写 #screen 前崩溃，整屏停在“加载中…”、所有点击无效果）。
   纯逻辑，无需 WebView；只给 app.js 一个最小 DOM 桩即可在 Node 跑。
   运行：node tests/m4_router.test.cjs */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const sc = f => fs.readFileSync(path.join(ROOT, 'www/js', f), 'utf8');

let pass = 0, fail = 0;
const lines = [];
const log = s => lines.push(s);
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; log('PASS  ' + name); }
  else { fail++; log('FAIL  ' + name + '\n       got : ' + g + '\n       want: ' + w); }
}

// 最小 DOM/环境桩：让 app.js 的 IIFE 末尾 document.addEventListener 不炸，且能读到 location
const G = globalThis;
G.document = { addEventListener: function () {} };
G.location = { hash: '' };
G.addEventListener = function () {};   // window 级（start 里用），此处不触发
G.Capacitor = undefined;

// app.js 顶层 var DB = root.NOVEL_DB（可为 undefined，resolve 不依赖它）；仅需 NOVEL_UTIL 供 esc 用
new Function(sc('util.js'))(G);
new Function(sc('app.js'))(G);

const App = G.NOVEL_APP;

(function run() {
  log('app.js 路由 resolve 回归  ' + new Date().toISOString());
  log('');

  // 核心：无 params 字段的路由不得抛，且 params 归一为空对象
  eq('shelf 无 params 不崩', (function () { try { App.resolve('#/shelf'); return true; } catch (e) { return 'THROW ' + e.message; } })(), true);
  eq('me 无 params 不崩', (function () { try { App.resolve('#/me'); return true; } catch (e) { return 'THROW ' + e.message; } })(), true);
  eq('#/shelf → view=shelf, params={}', App.resolve('#/shelf'), { view: 'shelf', params: {}, hash: '#/shelf' });
  eq('#/me → view=me, params={}', App.resolve('#/me'), { view: 'me', params: {}, hash: '#/me' });

  // 带 params 的路由照常取参（#/book 现带可选 tab 段，view 改为 book）
  eq('#/book/12 → bookId', App.resolve('#/book/12'), { view: 'book', params: { bookId: '12' }, hash: '#/book/12' });
  eq('#/book/12/chars → bookId+tab', App.resolve('#/book/12/chars'), { view: 'book', params: { bookId: '12', tab: 'chars' }, hash: '#/book/12/chars' });
  eq('#/editor/3/7 → bookId+chapterId', App.resolve('#/editor/3/7'), { view: 'editor', params: { bookId: '3', chapterId: '7' }, hash: '#/editor/3/7' });
  eq('#/chapter/9 → chapterId', App.resolve('#/chapter/9'), { view: 'chapter', params: { chapterId: '9' }, hash: '#/chapter/9' });
  eq('#/section/9/4 → chapterId+sectionId', App.resolve('#/section/9/4'), { view: 'section', params: { chapterId: '9', sectionId: '4' }, hash: '#/section/9/4' });
  eq('#/me/appearance → tab', App.resolve('#/me/appearance'), { view: 'me', params: { tab: 'appearance' }, hash: '#/me/appearance' });

  // 可选组缺省：tab 为 undefined（键存在但值 undefined），JSON 序列化会丢该键，不应崩
  (function () {
    var r;
    try { r = App.resolve('#/me'); } catch (e) { r = 'THROW ' + e.message; }
    eq('#/me 可选 tab 缺目不崩', typeof r === 'object' && r.view === 'me' && r.params.tab === undefined, true);
  })();

  // 非法/空 hash 回落默认书架，不抛
  eq('空 hash 回落 shelf', App.resolve('#/nope'), { view: 'shelf', params: {}, hash: '#/shelf' });

  log('');
  log('合计：' + pass + ' 通过 / ' + fail + ' 失败');
  fs.writeFileSync(path.join(__dirname, 'report-m4-router.txt'), lines.join('\n') + '\n', 'utf8');
  console.log(lines.filter(l => l.startsWith('FAIL')).join('\n') || '（无失败项）');
  console.log('M4-router ' + pass + ' passed, ' + fail + ' failed  -> tests/report-m4-router.txt');
  process.exitCode = fail ? 1 : 0;
})();
