var g = globalThis;
var keys = Object.keys(g).filter(function (k) { return /^NOVEL_/.test(k); });
var A = g.NOVEL_APP;
var state = A && A.state ? JSON.stringify({ bookId: A.state.bookId, tab: A.state.tab }) : 'nostate';
var cards = document.querySelectorAll('.book-card').length;
var DA = g.NOVEL_DATA_ACTIONS;
var DB = g.NOVEL_DB;
var out = 'GLOBALS=' + keys.join(',') + ' | hash=' + location.hash + ' | state=' + state + ' | shelfCards=' + cards;
// 尝试异步列书（若有 DB.listBooks）
try {
  if (DB && DB.listBooks) {
    var books = await DB.listBooks();
    out += ' | books=' + JSON.stringify(books.map(function (b) { return { id: b.id, title: b.title }; }));
  }
} catch (e) { out += ' | listBooksERR=' + e.message; }
return out;
