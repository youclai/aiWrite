// M6 文件逻辑件（纯电脑侧）：importer 分章 / zip STORE 读写 / exporter txt / zipper 作品包
// 全部零 IO、零第三方依赖：产物在内存断言。落盘（temp/export·分享）留真机联调。
const { readFileSync } = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', 'www');
const results = []; let started = 0;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(name, ok, detail) { results.push({ name, ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); }
function sc(rel) { return readFileSync(path.join(ROOT, rel), 'utf8'); }
function loadAll() {
  const G = globalThis;
  const mk = (key, code) => { if (typeof G[key] === 'undefined') new Function(code + '\n;')(); return G[key]; };
  mk('NOVEL_ZIP', sc('js/zip.js'));
  mk('NOVEL_EXPORTER', sc('js/exporter.js'));
  mk('NOVEL_IMPORTER', sc('js/importer.js'));
  mk('NOVEL_ZIPPER', sc('js/zipper.js'));   // 依赖 zip + exporter（已在其前注册到 globalThis）
  return { ZIP: G.NOVEL_ZIP, EXP: G.NOVEL_EXPORTER, IMP: G.NOVEL_IMPORTER, ZP: G.NOVEL_ZIPPER };
}

async function main() {
  const { ZIP, EXP, IMP, ZP } = loadAll();
  started = results.length;

  // ---- CRC32（对照 Node zlib.crc32，若可用）----
  const ab = new TextEncoder().encode('hello');
  log('zip.CRC32("hello")=0x3610a686', ZIP.crc32(ab) === 0x3610a686, String(ZIP.crc32(ab)));
  if (typeof zlib.crc32 === 'function') {
    const s = '中文 with mixed §∆ 内容 123';
    log('zip.CRC32 对照 zlib.crc32', ZIP.crc32(new TextEncoder().encode(s)) === zlib.crc32(Buffer.from(s, 'utf8')));
  } else log('zip.CRC32 对照 zlib（本机 Node 无 zlib.crc32，跳过）', true);

  // ---- ZIP STORE 写→读 往返 ----
  const entries = [
    { name: 'a.txt', data: 'content-A' },
    { name: '目录/中文.txt', data: 'content-B 中文' },
    { name: 'empty.txt', data: '' },
  ];
  const bytes = ZIP.build(entries);
  log('zip.build 返回 Uint8Array', bytes instanceof Uint8Array && bytes.length > 0, bytes.length + 'B');
  const back = ZIP.list(bytes);
  log('zip.list 条目数一致', back.length === 3);
  log('zip.list 名字还原(含中文路径)', back.map(e => e.name).join('|') === 'a.txt|目录/中文.txt|empty.txt', back.map(e => e.name).join(','));
  log('zip.list 内容往返', back[0].text() === 'content-A' && back[1].text() === 'content-B 中文' && back[2].text() === '');
  // 签名：本地头 / EOCD 以 PK 开头
  log('zip 以 PK\\x03\\x04 开头', bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04);

  // ---- importer：中文数字/阿拉伯/chapter 分章 ----
  const t1 = [
    '第一章　开端',
    '　正文甲。',
    '第二行仍在同一章。',
    '',
    '第二章 转折',
    '正文乙。',
    '第3章',
    '正文丙。',
  ].join('\n');
  const c1 = IMP.split(t1);
  log('importer 切出 3 章', c1.length === 3, JSON.stringify(c1.map(c => c.title)));
  log('importer 标题保留', c1[0].title.startsWith('第一章') && c1[1].title === '第二章 转折' && c1[2].title === '第3章');
  log('importer 正文不含标题行', c1[0].body.includes('正文甲') && !c1[0].body.includes('第一章　开端'));
  log('importer 单章正文跨段合并', c1[0].body.includes('第二行仍在同一章'));

  // chapter N（英文）+ 序章
  const t2 = ['序章', '这是序的内容', 'chapter 1', 'first body', 'Chapter 2', 'second body'].join('\n');
  const c2 = IMP.split(t2);
  log('importer 识别 序章/chapter N', c2.length === 3 && c2[0].title === '序章', JSON.stringify(c2.map(c => c.title)));

  // 降级：无章标题 → 按空行分块
  const t3 = '块一的段落。\n还是块一。\n\n块二的段落。\n\n块三。';
  const c3 = IMP.split(t3);
  log('importer 无标题降级按空行分块=3', c3.length === 3 && c3.every(c => c.title === ''), JSON.stringify(c3.map(c => c.body)));

  // 引子不丢：首个标题前还有文字
  const t4 = '本书由某某扫描，谨作纪念。\n\n第一章 正文\n内容。';
  const c4 = IMP.split(t4);
  log('importer 保留首标题前的引子块', c4.length === 2 && c4[0].title === '' && c4[0].body.includes('谨作纪念'), JSON.stringify(c4.map(c => c.title)));

  // \r\n 归一
  const c5 = IMP.split('第一章\r\n甲\r\n第二章\r\n乙');
  log('importer 归一 CRLF', c5.length === 2 && c5[0].body === '甲');

  // ---- exporter：默认纯正文 / 可选章号 / BOM ----
  const chapters = [
    { idx: 1, title: '开端', body: '段落一\n\n段落二', word_count: 6 },
    { idx: 2, title: '转折', body: '正文乙', word_count: 3 },
  ];
  const plain = EXP.fullText({ title: '书', synopsis: '梗概' }, chapters, {});
  log('exporter 默认纯正文(不含标题/章号)', plain === '段落一\n\n段落二\n\n正文乙', JSON.stringify(plain));
  const numbered = EXP.fullText({ title: '书', synopsis: '梗概' }, chapters, { includeNumber: true });
  log('exporter includeNumber 含章号标题', numbered.includes('第1章　开端') && numbered.includes('第2章　转折'));
  const fm = EXP.fullText({ title: '我的书', synopsis: '一句话梗概' }, chapters, { includeFrontmatter: true });
  log('exporter 可附书名梗概头', fm.startsWith('我的书') && fm.includes('一句话梗概') && fm.includes('段落一'));
  const files = EXP.chapterFiles(chapters, { includeNumber: false });
  log('exporter 分章文件名带两位序号', files[0].name === '01 开端.txt' && files[1].name === '02 转折.txt', files.map(f => f.name).join(','));

  // 写盘 BOM：注入内存 sink 断言首字符
  const sink = { _m: {}, write(cat, name, content) { this._m[cat + '/' + name] = content; return Promise.resolve(cat + '/' + name); } };
  await EXP.writeTxt('book.txt', '正文', sink);
  const written = sink._m['export/book.txt'];
  log('exporter.writeTxt 前置 BOM', written.charCodeAt(0) === 0xFEFF && written.slice(1) === '正文');

  // ---- zipper：作品包 namelist 齐全 ----
  const book = { title: '测试书', synopsis: '梗概', author: '某甲' };
  const chars = [{ name: '林深', role: '主角', aliases: ['小深'], personality: '寡言', speech_style: '短句', taboos: '不近女色' }];
  const pkg = ZP.buildNovelZip(book, chapters, chars);
  const names = pkg.entries.map(e => e.name);
  log('zipper 含全本/分章/角色卡/结构',
    names.includes('测试书.txt') && names.some(n => n.includes('/分章/') && n.endsWith('.txt'))
    && names.some(n => n.endsWith('角色卡.md')) && names.some(n => n.endsWith('章节结构.md')),
    names.join(','));
  // 打实 zip 再读回校验 namelist + 内容
  const reread = ZIP.list(pkg.bytes);
  const map = {}; reread.forEach(e => { map[e.name] = e.text(); });
  log('zipper 作品包可被 zip.list 读回', reread.length === names.length);
  log('zipper 全本含两章正文', map['测试书.txt'].includes('段落一') && map['测试书.txt'].includes('正文乙'));
  log('zipper 角色卡含别名与禁忌', map['测试书/角色卡.md'].includes('小深') && map['测试书/角色卡.md'].includes('不近女色'));
  log('zipper 章节结构含章号', map['测试书/章节结构.md'].includes('第1章 开端'));

  const failed = results.filter(r => !r.ok).length;
  console.log('\n[单测] 通过 ' + (results.length - failed) + ' 失败 ' + failed);
  const out = results.map(r => (r.ok ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? ' | ' + r.detail : '')).join('\n')
    + '\n\n合计 ' + results.length + ' 项，失败 ' + failed + ' 项。\n';
  require('fs').writeFileSync(path.join(__dirname, 'report-m6.txt'), out, 'utf8');
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('HARNESS ERROR:', e && e.stack || e); require('fs').writeFileSync(path.join(__dirname, 'report-m6.txt'), 'HARNESS ERROR: ' + (e && e.stack || e), 'utf8'); process.exit(2); });
