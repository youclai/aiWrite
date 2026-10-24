/* m10_docx_import.test.cjs —— docx 读取与导入自动识别（优化批次 A）回归（Node 侧）
   覆盖：zip DEFLATE 解压（注入 zlib）/同步读回引导报错、docx extractText 段落解析
   （实体还原/tab/br/w:del 剔除/instrText 剔除）、readDocument 魔数三分流、
   “同一文本直接粘 vs 塞进 docx 再读”双路 importBook 产出树一致（§4.1 兜底）。
   运行：node tests/m10_docx_import.test.cjs ；退出码 0=全绿。 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const sc = f => fs.readFileSync(path.join(ROOT, 'www/js', f), 'utf8');
const out = [];
let pass = 0, fail = 0;
const log = (...a) => out.push(a.join(' '));
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; log(`  PASS ${name}`); }
  else { fail++; log(`  FAIL ${name}\n       got : ${g}\n       want: ${w}`); }
};
const ok = (name, cond, hint) => eq(name, !!cond, true);
const contains = (name, hay, needle) => ok(name, String(hay).indexOf(needle) >= 0, 'needle=' + needle + ' hay=' + JSON.stringify(String(hay).slice(0, 160)));
const G = globalThis;
const enc = new TextEncoder();

function makeAdapter() {
  const d = new DatabaseSync(':memory:');
  return {
    db: d,
    all: (sql, params) => d.prepare(sql).all(...(params || [])),
    run: (sql, params) => { const r = d.prepare(sql).run(...(params || [])); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; },
    exec: (sql) => d.exec(sql),
    close: () => d.close()
  };
}

/* 手工打一个 DEFLATE 压缩的 zip（外部 Word/WPS 产物形态）：本地头+中央目录+EOCD，method=8 */
function pushU16(a, v) { a.push(v & 255, (v >> 8) & 255); }
function pushU32(a, v) { a.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); }
function makeDeflateZip(entries) {
  const parts = [], cds = [];
  let offset = 0;
  entries.forEach(function (e) {
    const nameB = enc.encode(e.name);
    const raw = e.data instanceof Uint8Array ? e.data : enc.encode(e.data);
    const comp = new Uint8Array(zlib.deflateRawSync(raw));
    const crc = G.NOVEL_ZIP.crc32(raw);
    const lh = [];
    pushU32(lh, 0x04034b50); pushU16(lh, 20); pushU16(lh, 0x0800); pushU16(lh, 8);
    pushU16(lh, 0); pushU16(lh, 0x21);
    pushU32(lh, crc); pushU32(lh, comp.length); pushU32(lh, raw.length);
    pushU16(lh, nameB.length); pushU16(lh, 0);
    const lhA = Uint8Array.from(lh);
    parts.push(lhA, nameB, comp);
    const ch = [];
    pushU32(ch, 0x02014b50); pushU16(ch, 20); pushU16(ch, 20); pushU16(ch, 0x0800); pushU16(ch, 8);
    pushU16(ch, 0); pushU16(ch, 0x21);
    pushU32(ch, crc); pushU32(ch, comp.length); pushU32(ch, raw.length);
    pushU16(ch, nameB.length); pushU16(ch, 0); pushU16(ch, 0);
    pushU16(ch, 0); pushU16(ch, 0); pushU32(ch, 0); pushU32(ch, offset);
    cds.push(Uint8Array.from(ch), nameB);
    offset += lhA.length + nameB.length + comp.length;
  });
  let cdSize = 0; cds.forEach(c => { cdSize += c.length; });
  const eo = [];
  pushU32(eo, 0x06054b50); pushU16(eo, 0); pushU16(eo, 0);
  pushU16(eo, entries.length); pushU16(eo, entries.length);
  pushU32(eo, cdSize); pushU32(eo, offset); pushU16(eo, 0);
  const all = parts.concat(cds, [Uint8Array.from(eo)]);
  const total = all.reduce((s, b) => s + b.length, 0);
  const res = new Uint8Array(total); let p = 0;
  all.forEach(b => { res.set(b, p); p += b.length; });
  return res;
}

/* 把纯文本按行包成 <w:p> 段落 → document.xml 字符串（模拟 Word 保存的正文部件） */
function textToDocXml(text) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ps = String(text).split('\n').map(l => '<w:p><w:r><w:t xml:space="preserve">' + esc(l) + '</w:t></w:r></w:p>').join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + ps + '</w:body></w:document>';
}
const inflateZlib = u8 => Promise.resolve(new Uint8Array(zlib.inflateRawSync(u8)));

(async () => {
  for (const f of ['schema.js', 'db.js', 'zip.js', 'docx.js', 'importer.js', 'structuredImport.js', 'dataActions.js']) new Function(sc(f))(G);
  const ZIP = G.NOVEL_ZIP, DOCX = G.NOVEL_DOCX, DB = G.NOVEL_DB, DA = G.NOVEL_DATA_ACTIONS;
  ok('模块齐备', ZIP && DOCX && DB && DA && typeof DA.readDocument === 'function');

  /* ============ Z1 zip 读回：STORE 同步 / DEFLATE 引导 ============ */
  const storeZip = ZIP.build([{ name: 'a.txt', data: '你好 hello' }]);
  const sl = ZIP.list(storeZip);
  eq('Z1 STORE method=0', sl[0].method, 0);
  eq('Z1 STORE text 直读', sl[0].text(), '你好 hello');

  const docXml = [
    '<w:p><w:r><w:t>第一章　磕睡</w:t></w:r></w:p>',
    '<w:p><w:r><w:t xml:space="preserve">正文A&amp;B</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>带Tab一节</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>第一行</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>第二行</w:t></w:r></w:p>',
    '<w:p><w:del><w:r><w:delText>被删的内容</w:delText></w:r></w:del><w:r><w:t>保留的内容</w:t></w:r></w:p>',
    '<w:p><w:r><w:instrText>TOC \\o "1-3"</w:instrText></w:r></w:p>',
    '<w:p><w:r><w:t>第二章　转折</w:t></w:r><w:r><w:t xml:space="preserve"> 150&lt;&#60;1000&gt;</w:t></w:r></w:p>',
  ].join('');
  const dxml = '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>' + docXml + '</w:body></w:document>';
  const defZip = makeDeflateZip([{ name: 'word/document.xml', data: dxml }, { name: '[Content_Types].xml', data: '<Types/>' }]);

  const dl = ZIP.list(defZip);
  eq('Z2 DEFLATE method=8', dl[0].method, 8);
  let threw = '';
  try { dl[0].text(); } catch (e) { threw = e.message; }
  contains('Z2 同步 text() 报错引导 listAsync', threw, 'DEFLATE');

  /* ============ Z3 listAsync 注入 zlib inflate ============ */
  const dla = await ZIP.listAsync(defZip, { inflate: inflateZlib });
  eq('Z3 解压后 method=0', dla[0].method, 0);
  eq('Z3 解压字节一致', dla[0].data.length, enc.encode(dxml).length);
  contains('Z3 解压内容', dla[0].text(), '第一章　磕睡');

  /* ============ Z4 docx extractText 段落解析 ============ */
  const txt = await DOCX.extractText(defZip, { inflate: inflateZlib });
  eq('Z4 段落整体输出', txt,
    '第一章　磕睡\n正文A&B\t带Tab一节\n第一行\n第二行\n保留的内容\n第二章　转折 150<<1000>');
  ok('Z4 w:del 内容不出现', txt.indexOf('被删的内容') < 0);
  ok('Z4 域代码不混进正文', txt.indexOf('TOC') < 0);

  /* ============ Z5 自产 STORE docx 往返（method 两分支同读通） ============ */
  const built = DOCX.build({ title: '往返书', author: '甲' }, [{ idx: 1, title: '第一章　起点', body: '往返正文段一。\n往返正文段二。' }], {});
  const round = await DOCX.extractText(built.bytes, { inflate: inflateZlib });
  contains('Z5 STORE docx 抽出章标题', round, '第一章　起点');
  contains('Z5 STORE docx 抽出正文', round, '往返正文段二。');

  /* ============ Z6 readDocument 魔数三分流 ============ */
  const txtBytes = enc.encode('第1章 甲\n\u3000\u3000内容甲。\n第2章 乙\n\u3000\u3000内容乙。');
  const rTxt = await DA.readDocument(txtBytes);
  eq('Z6 纯文本 → kind=text', rTxt.kind, 'text');
  contains('Z6 文本原样解出', rTxt.text, '内容甲。');
  const rDocx = await DA.readDocument(defZip);
  eq('Z6 PK 容器 → kind=docx', rDocx.kind, 'docx');
  contains('Z6 docx 抽出正文', rDocx.text, '保留的内容');
  const ole = new Uint8Array(64); ole[0] = 0xD0; ole[1] = 0xCF; ole[2] = 0x11; ole[3] = 0xE0;
  const rOle = await DA.readDocument(ole);
  eq('Z6 D0CF → kind=reject', rOle.kind, 'reject');
  contains('Z6 .doc 拒绝文案可读', rOle.error, '另存为 .docx');

  /* ============ Z7 缺 document.xml → 明确报错不产乱码 ============ */
  const noDoc = makeDeflateZip([{ name: 'word/styles.xml', data: '<x/>' }]);
  let err7 = '';
  try { err7 = await DA.readDocument(noDoc); err7 = 'NO-THROW'; } catch (e) { err7 = e.message; }
  contains('Z7 非 docx 容器报错', err7, 'Word 文档');

  /* ============ Z8 一致性兜底：直接粘 vs docx 两路 importBook 产出树相同 ============ */
  const SAMPLE = '第1章 甲\n\u3000\u3000内容甲一。\n\u3000\u3000内容甲二。\n第2章 乙\n\u3000\u3000内容乙。\n第3章 丙\n\u3000\u3000内容丙。';
  async function importAndList(text) {
    const a = makeAdapter(); await DB.init(a);
    const r = await DA.importBook({ db: DB }, { mode: 'new', title: '一致性', text: text, format: 'split' });
    const chs = await DB.listChapters(r.bookId);
    const bodies = [];
    for (const c of chs) { const full = await DB.getChapter(c.id); bodies.push(full.body); }
    a.close();
    return { titles: chs.map(c => c.title), bodies: bodies, sections: chs.length };
  }
  const t1 = await importAndList(SAMPLE);
  const t2 = await importAndList(await DOCX.extractText(makeDeflateZip([{ name: 'word/document.xml', data: textToDocXml(SAMPLE) }]), { inflate: inflateZlib }));
  eq('Z8 章数一致', t1.titles.length, t2.titles.length);
  eq('Z8 章标题树一致', t2.titles, t1.titles);
  eq('Z8 章正文一字不差', t2.bodies, t1.bodies);

  /* ============ Z9 环境内建 inflate（Node 18+/真机 Chromium 80+ 同路径） ============ */
  let msg9 = 'ok';
  try {
    const e9 = await ZIP.listAsync(defZip);
    contains('Z9 默认 inflate 可用', e9[0].text(), '第一章　磕睡');
  } catch (e) {
    msg9 = e && e.code;
    eq('Z9 能力缺失显式报 need-inflate', e.code, 'need-inflate');
  }
  if (msg9 !== 'ok') log('  INFO Z9 走了 need-inflate 降级分支: ' + msg9);

  const failed = fail;
  console.log(out.join('\n'));
  console.log(`\n[单测] 通过 ${pass} 失败 ${failed}`);
  fs.writeFileSync(path.join(__dirname, 'report-m10-docx-import.txt'), out.join('\n') + `\n\n合计 ${pass + failed} 项，失败 ${failed} 项。\n`, 'utf8');
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  fs.writeFileSync(path.join(__dirname, 'report-m10-docx-import.txt'), 'HARNESS ERROR: ' + (e && e.stack || e), 'utf8');
  process.exit(2);
});
