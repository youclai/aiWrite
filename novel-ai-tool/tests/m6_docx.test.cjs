// M6-b docx（纯电脑侧）：手写最小 OOXML，复用 zip.js。全结构断言，不靠肉眼打开。
const { readFileSync } = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'www');
const results = [];
function log(name, ok, detail) { results.push({ name, ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); }
function sc(rel) { return readFileSync(path.join(ROOT, rel), 'utf8'); }
function loadAll() {
  const G = globalThis;
  const mk = (key, code) => { if (typeof G[key] === 'undefined') new Function(code + '\n;')(); return G[key]; };
  mk('NOVEL_ZIP', sc('js/zip.js'));
  mk('NOVEL_DOCX', sc('js/docx.js'));
  return { ZIP: G.NOVEL_ZIP, DOCX: G.NOVEL_DOCX };
}

function nameSet(entries) { return entries.map(e => e.name); }

async function main() {
  const { ZIP, DOCX } = loadAll();
  const book = { title: '长风渡', author: '某甲', synopsis: '一句话梗概<&>' };
  const chapters = [
    { idx: 1, title: '第一章　开端', body: '第一段正文。\n第二段正文。\n\n   ', word_count: 12 },
    { idx: 2, title: '第二章 转折', body: '乙章内容。', word_count: 5 },
  ];
  const out = DOCX.build(book, chapters, { totalWords: 204800 });

  // 打包为 zip 且可被 zip.list 读回（往返）
  log('docx.build 返回 Uint8Array', out.bytes instanceof Uint8Array && out.bytes.length > 0, out.bytes.length + 'B');
  const back = ZIP.list(out.bytes);
  const names = nameSet(back);

  // 部件齐全
  ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/header1.xml']
    .forEach(p => log('namelist 含 ' + p, names.indexOf(p) >= 0, names.join(',')));

  const get = n => { for (const e of back) if (e.name === n) return e.text(); return ''; };

  // document.xml：含 pageBreakBefore、正文、章标题、页眉引用
  const doc = get('word/document.xml');
  log('document.xml 含 pageBreakBefore', doc.indexOf('<w:pageBreakBefore/>') >= 0);
  log('document.xml 含章标题', doc.includes('第一章　开端') && doc.includes('第二章 转折'));
  log('document.xml 正文分段(两 run)', doc.includes('第一段正文。') && doc.includes('第二段正文。'));
  log('document.xml 引用页眉 headerReference', doc.includes('<w:headerReference') && doc.includes('r:id="rId2"'));
  log('document.xml 有 sectPr + A4 页面', doc.includes('<w:sectPr>') && doc.includes('w:w="11906"'));

  // 标题页
  log('document.xml 标题页含书名/作者/梗概', doc.includes('长风渡') && doc.includes('作者：某甲') && doc.includes('一句话梗概'));

  // header1.xml：含总字数
  const hdr = get('word/header1.xml');
  log('header1.xml 页眉含书名', hdr.includes('长风渡'));
  log('header1.xml 页眉含总字数', hdr.includes('204800'), hdr.slice(0, 200));

  // styles.xml：中文排版
  const sty = get('word/styles.xml');
  log('styles.xml 首行缩进 firstLineChars=200', sty.includes('w:firstLineChars="200"'));
  log('styles.xml eastAsia=宋体', sty.includes('w:eastAsia="宋体"'));

  // [Content_Types].xml：各部件 override 齐全
  const ct = get('[Content_Types].xml');
  log('ContentTypes 覆盖 document/styles/header',
    ct.includes('/word/document.xml') && ct.includes('/word/styles.xml') && ct.includes('/word/header1.xml'));

  // 关系：document.xml.rels 指向 styles + header
  const dr = get('word/_rels/document.xml.rels');
  log('document.xml.rels 关联 styles 与 header', dr.includes('styles.xml') && dr.includes('Target="header1.xml"'));

  // XML 转义：梗概里的 < & > 必须被转义，不得原样出现在正文文本节点
  log('XML 转义 <&> 不出现在文档', doc.indexOf('梗概<&>') < 0 && (doc.includes('&lt;') || doc.includes('&amp;')));

  // 控制字符剔除
  const dirty = DOCX.build({ title: '脏\u0000字\u000B符' }, [{ title: 'x', body: 'a\u0007b' }], {});
  const ddoc = ZIP.list(dirty.bytes).filter(e => e.name === 'word/document.xml')[0].text();
  log('docx 剔除 XML 非法控制字符', ddoc.indexOf('\u0000') < 0 && ddoc.indexOf('\u0007') < 0);

  // 开关：includeHeader=false → 无 header1.xml 部件、无 headerReference、ContentTypes 不覆盖 header
  const noHdr = DOCX.build(book, chapters, { includeHeader: false, totalWords: 1 });
  const nh = nameSet(noHdr.entries);
  log('includeHeader=false 去掉 header1.xml 部件', nh.indexOf('word/header1.xml') < 0);
  const nhDoc = noHdr.entries.filter(e => e.name === 'word/document.xml')[0].data;
  log('includeHeader=false 无 headerReference', nhDoc.indexOf('headerReference') < 0);
  const nhCt = noHdr.entries.filter(e => e.name === '[Content_Types].xml')[0].data;
  log('includeHeader=false ContentTypes 不含 header override', nhCt.indexOf('header1.xml') < 0);

  // 开关：pageBreak=false → document.xml 不含 pageBreakBefore
  const noPb = DOCX.build(book, chapters, { pageBreak: false });
  const noPbDoc = noPb.entries.filter(e => e.name === 'word/document.xml')[0].data;
  log('pageBreak=false 不含 pageBreakBefore', noPbDoc.indexOf('<w:pageBreakBefore/>') < 0);

  const failed = results.filter(r => !r.ok).length;
  console.log('\n[单测] 通过 ' + (results.length - failed) + ' 失败 ' + failed);
  const out2 = results.map(r => (r.ok ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? ' | ' + r.detail : '')).join('\n')
    + '\n\n合计 ' + results.length + ' 项，失败 ' + failed + ' 项。\n';
  require('fs').writeFileSync(path.join(__dirname, 'report-m6-docx.txt'), out2, 'utf8');
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('HARNESS ERROR:', e && e.stack || e); require('fs').writeFileSync(path.join(__dirname, 'report-m6-docx.txt'), 'HARNESS ERROR: ' + (e && e.stack || e), 'utf8'); process.exit(2); });
