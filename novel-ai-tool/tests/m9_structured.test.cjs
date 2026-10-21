/* m9_structured.test.cjs —— 外部导入（章 > 节两层结构）回归（Node 侧，node:sqlite）
   A 组：structuredImport.js 纯解析（§6.1 A1–A10，含 §6.2 采纳的三道护栏推荐语义）
   B 组：dataActions.importBook format='structured' 端到端落库 / 建节 / 并入 / 失败进度（B1–B6）
   运行：node tests/m9_structured.test.cjs ；退出码 0=全绿。 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['schema.js', 'db.js', 'importer.js', 'structuredImport.js', 'dataActions.js'];
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
const G = globalThis;

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

// §2 样本（正文行以全角空格 U+3000 缩进，标题行不缩进——贴合中文排版护栏）
const SAMPLE = [
  '封面',
  '名称：瞌睡虫的美梦',
  '作者：qd',
  '文体：小说',
  '类别：长篇小说 ~ 5 章',
  '风格：爱情',
  '时间：2026-10-20',
  '长度：145 字',
  '阅读章显示：章号与标题',
  '阅读节显示：节号',
  '',
  '第1章 章标题',
  '',
  '\u3000\u3000这是章的内容建设局叙叙不是两个电脑ID',
  '',
  '第1节 节标题',
  '',
  '\u3000\u3000记得极地世界网吧的你虚敦煌石窟客户端那等你开学后',
  '',
  '\u3000\u3000寿命',
  '',
  '第2节 节标题',
  '',
  '\u3000\u3000记得记得和你愉快印度都呢就',
  '',
  '\u3000\u3000孔',
  '',
  '第2章 章标题',
  '第3章 章标题',
  '第4章 章标题',
  '第5章 章标题'
].join('\n');

(async () => {
  for (const f of FILES) new Function(sc(f))(G);
  const DB = G.NOVEL_DB, DA = G.NOVEL_DATA_ACTIONS, SI = G.NOVEL_STRUCTURED_IMPORT;
  ok('NOVEL_STRUCTURED_IMPORT 已加载', SI && typeof SI.parse === 'function');

  /* ============ A 组：纯解析层 ============ */
  log('== A1 样本主链 ==');
  const a1 = SI.parse(SAMPLE);
  eq('A1 书名', a1.bookMeta.title, '瞌睡虫的美梦');
  eq('A1 作者', a1.bookMeta.author, 'qd');
  eq('A1 章数=5', a1.chapters.length, 5);
  eq('A1 首章去前缀标题', a1.chapters[0].title, '章标题');
  eq('A1 首章编号 no=1', a1.chapters[0].no, 1);
  eq('A1 首章含 2 节', a1.chapters[0].sections.length, 2);
  ok('A1 章直正文入章 body', a1.chapters[0].body.indexOf('这是章的内容') >= 0, a1.chapters[0].body);
  ok('A1 节正文两段齐全', a1.chapters[0].sections[0].body.indexOf('记得极地') >= 0 && a1.chapters[0].sections[0].body.indexOf('寿命') >= 0, a1.chapters[0].sections[0].body);
  ok('A1 节正文已去缩进(U+3000)', a1.chapters[0].sections[0].body.indexOf('\u3000') < 0);
  eq('A1 空章保留(第2章)', [a1.chapters[1].body, a1.chapters[1].sections.length], ['', 0]);
  eq('A1 stats.chapters', a1.report.stats.chapters, 5);
  eq('A1 stats.sections', a1.report.stats.sections, 2);
  eq('A1 stats.emptyChapters', a1.report.stats.emptyChapters, 4);
  const a1words = a1.chapters.reduce((acc, c) => acc + SI.countNonSpace(c.body) + c.sections.reduce((b, s) => b + SI.countNonSpace(s.body), 0), 0);
  eq('A1 stats.words 自洽', a1.report.stats.words, a1words);
  ok('A1 stats.words>0', a1.report.stats.words > 0, a1.report.stats.words);
  ok('A1 空章按 §3.5 保留并记异常（唯一异常）', a1.report.anomalies.length === 1 && /保留为空章/.test(a1.report.anomalies[0]), JSON.stringify(a1.report.anomalies));

  log('== A2 封面 8 行逐行丢弃留痕 ==');
  eq('A2 metaLines=8', a1.report.dropped.metaLines, 8);
  const kept = a1.report.frontmatter.filter(x => x.action === 'kept').map(x => x.reason);
  ok('A2 kept 含书名', kept.some(r => /书名/.test(r)), JSON.stringify(kept));
  ok('A2 kept 含作者', kept.some(r => /作者/.test(r)), JSON.stringify(kept));
  const dropReasons = a1.report.frontmatter.filter(x => x.action === 'dropped').map(x => x.line).join('|');
  ['封面', '文体', '类别', '风格', '时间', '长度', '阅读章显示', '阅读节显示'].forEach(k => ok('A2 丢弃留痕含「' + k + '」', dropReasons.indexOf(k) >= 0));

  log('== A3 zh2num ==');
  eq('A3 十二=12', SI.zh2num('十二'), 12);
  eq('A3 二十一=21', SI.zh2num('二十一'), 21);
  eq('A3 一百零八=108', SI.zh2num('一百零八'), 108);
  eq('A3 三=3', SI.zh2num('三'), 3);
  eq('A3 7=7', SI.zh2num('7'), 7);
  eq('A3 一万=10000', SI.zh2num('一万'), 10000);
  eq('A3 〇=0', SI.zh2num('〇'), 0);

  log('== A4 分类边界（单行探针 + §6.2-1 采纳的多行 parse 验证）==');
  eq('A4 第1章 章标题→chapter', SI.classify('第1章 章标题').kind, 'chapter');
  const a4loose = SI.classify('第1章章标题');
  eq('A4 第1章章标题→chapter', a4loose.kind, 'chapter');
  eq('A4 宽松章去前缀 title', a4loose.title, '章标题');
  eq('A4 第十二章 起风 no=12', SI.classify('第十二章 起风').no, 12);
  eq('A4 裸题第3章 title=""', SI.classify('第3章').title, '');
  eq('A4 缩进句→body', SI.classify('\u3000\u3000第3章 他走了进来。').kind, 'body');
  eq('A4 第2节 节标题→section', SI.classify('第2节 节标题').kind, 'section');
  eq('A4 第2节 isChapterLine=false', SI.isChapterLine('第2节 节标题'), false);
  eq('A4 第2节 isSectionLine=true', SI.isSectionLine('第2节 节标题'), true);
  const a4dot = SI.classify('6.1 归本章');
  eq('A4 6.1 归本章→dotted', a4dot.kind, 'dotted');
  eq('A4 6.1 sub=1', a4dot.sub, 1);
  // §6.2-1：'第一节约用水很重要' 单行探针无法反映上下文——用 parse 多行夹具验证（上一行为不缩进正文→判 body）
  const a4amb = SI.parse('第1章 开篇\n这是不缩进的正文第一句\n第一节约用水很重要');
  eq('A4 歧义句不误判为节(sections=0)', a4amb.chapters[0].sections.length, 0);
  ok('A4 歧义句落入章正文', a4amb.chapters[0].body.indexOf('第一节约用水很重要') >= 0, a4amb.chapters[0].body);

  log('== A5 点号编号全归本章、绝不新章、记不一致异常（§6.2-2 采纳护栏语义）==');
  const a5 = SI.parse('第1章 章标题\n\n6.1 甲\n\u3000\u3000正文甲\n6.2 乙\n\u3000\u3000正文乙');
  eq('A5 仍只 1 章', a5.chapters.length, 1);
  eq('A5 两点号都归本章→2 节', a5.chapters[0].sections.length, 2);
  eq('A5 首节 no 沿用所属章=1', a5.chapters[0].sections[0].no, 1);
  ok('A5 记「编号不一致」异常', a5.report.anomalies.some(x => /不一致/.test(x)), JSON.stringify(a5.report.anomalies));

  log('== A6 节号复位（新章下节号重新起算）==');
  const a6 = SI.parse('第1章 A\n第1节 s1\n\u3000b\n第2节 s2\n\u3000b\n第2章 B\n第1节 s3\n\u3000b');
  eq('A6 章数=2', a6.chapters.length, 2);
  eq('A6 首章节数=2', a6.chapters[0].sections.length, 2);
  eq('A6 次章节数=1', a6.chapters[1].sections.length, 1);
  eq('A6 次章首节 no=1', a6.chapters[1].sections[0].no, 1);

  log('== A7 章直正文与节并存互不串 ==');
  const a7 = SI.parse('第1章 A\n章内直正文一句\n第1节 s1\n节内正文一句');
  ok('A7 章直正文归章', a7.chapters[0].body.indexOf('章内直正文') >= 0, a7.chapters[0].body);
  eq('A7 章仍含 1 节', a7.chapters[0].sections.length, 1);
  ok('A7 节正文归节且不串章', a7.chapters[0].sections[0].body.indexOf('节内正文') >= 0 && a7.chapters[0].body.indexOf('节内正文') < 0);

  log('== A8 / A8b 空单元与自动补章 ==');
  const a8 = SI.parse('第1章 只有一章\n\u3000正文');
  eq('A8 无节章 sections=[]', a8.chapters[0].sections.length, 0);
  const a8b = SI.parse('第1节 先出现的节\n\u3000正文');
  eq('A8b 节先于章→自动补 1 章', a8b.chapters.length, 1);
  eq('A8b 补章下含 1 节', a8b.chapters[0].sections.length, 1);
  ok('A8b 记「自动补一章」异常', a8b.report.anomalies.some(x => /自动补一章/.test(x)), JSON.stringify(a8b.report.anomalies));

  log('== A9 BOM + CRLF + NBSP 缩进结果与干净样本一致 ==');
  const dirty = '\uFEFF' + SAMPLE.replace(/\n/g, '\r\n').replace(/\u3000\u3000/g, '\u00a0\u00a0');
  const a9 = SI.parse(dirty);
  eq('A9 章数一致', a9.chapters.length, a1.chapters.length);
  eq('A9 节数一致', a9.report.stats.sections, a1.report.stats.sections);
  eq('A9 书名一致', a9.bookMeta.title, a1.bookMeta.title);
  eq('A9 首章正文一致', a9.chapters[0].body, a1.chapters[0].body);
  eq('A9 首节正文一致', a9.chapters[0].sections[0].body, a1.chapters[0].sections[0].body);

  log('== A10 全文无标题→chapters=0 + 异常 ==');
  const a10 = SI.parse('这是一段没有任何章节标题的散文，只有正文而已。');
  eq('A10 无章', a10.chapters.length, 0);
  ok('A10 记「未识别到任何」异常', a10.report.anomalies.some(x => /未识别到任何/.test(x)), JSON.stringify(a10.report.anomalies));

  log('== R3 跳号/复位不误判为换章/新单元（§2-R3）==');
  const r3 = SI.parse('第1章 A\n第3节 s1\n\u3000b\n第2章 B\n第1节 s2\n\u3000b');
  eq('R3 章数=2', r3.chapters.length, 2);
  eq('R3 节号3仍归首章(首章一1节)', r3.chapters[0].sections.length, 1);
  eq('R3 次章节号复位=1', r3.chapters[1].sections[0].no, 1);

  log('== A5′ 紧凑件：dotted 豁免③，无空行也识别为节（方案a）==');
  const a5p = SI.parse('第1章 甲\n1.1 一\n\u3000\u3000正文甲\n1.2 二\n\u3000\u3000正文乙');
  eq('A5′ 仍只 1 章', a5p.chapters.length, 1);
  eq('A5′ ch1 得两节(1.1/1.2)', a5p.chapters[0].sections.length, 2);

  log('== 宽松形③：上一行是标题→识别；上一行是正文→拦下 ==');
  eq('宽松形接标题→新章', SI.parse('第1章 甲\n第2章乙').chapters.length, 2);
  eq('宽松形接正文→不新增章', SI.parse('第1章 甲\n这是正文一句\n第2章乙').chapters.length, 1);

  log('== EMPTY-SEC 有标题无正文的空节保留（§3.5 Q4）==');
  const es = SI.parse('第1章 甲\n\u3000正文\n第1节 空节');
  eq('EMPTY-SEC 保留 1 节', es.chapters[0].sections.length, 1);
  eq('EMPTY-SEC 空节 body=""', es.chapters[0].sections[0].body, '');
  eq('EMPTY-SEC stats.emptySections=1', es.report.stats.emptySections, 1);
  ok('EMPTY-SEC 记「保留…空节」', es.report.anomalies.some(x => /空节/.test(x)), JSON.stringify(es.report.anomalies));

  log('== F-split 三格式对同一文本的产出（§6 F-split）==');
  const FTEXT = '第1章 甲\n章直段\n第1节 一\n节段一\n第2节 二\n节段二\n第2章 乙\n乙章段';
  const fsp = SI.parse(FTEXT), fcp = SI.parseChapters(FTEXT), fspon = SI.parseSections(FTEXT);
  eq('F split 2章', fsp.chapters.length, 2);
  eq('F split 首章2节', fsp.chapters[0].sections.length, 2);
  eq('F chapterOnly 2章', fcp.chapters.length, 2);
  ok('F chapterOnly 节恒空', fcp.chapters.every(c => c.sections.length === 0));
  ok('F chapterOnly 节标题行并入章正文不丢字', fcp.chapters[0].body.indexOf('第1节 一') >= 0 && fcp.chapters[0].body.indexOf('节段一') >= 0, fcp.chapters[0].body);
  eq('F sectionOnly 3节(含开头无题节)', fspon.sections.length, 3);
  ok('F sectionOnly 章行降级并入节正文不丢字', fspon.sections.some(s => s.body.indexOf('第1章 甲') >= 0) && fspon.sections.some(s => s.body.indexOf('第2章 乙') >= 0), JSON.stringify(fspon.sections.map(s => s.body)));

  log('== ENC decodeTxt：UTF-8 正常 / 非法 UTF-8 字节回退 GB18030（§6 ENC）==');
  const utf8b = new TextEncoder().encode('名称：测试书名\n\n第1章 甲\n\u3000\u3000正文');
  const dU = SI.decodeTxt(utf8b);
  eq('ENC UTF-8 路径 encoding', dU.encoding, 'UTF-8');
  ok('ENC UTF-8 无替换符', dU.text.indexOf('\uFFFD') < 0, dU.text.slice(0, 20));
  const gbb = Uint8Array.from([0xD0, 0xD0, 0xC3, 0xFB, 0xA3, 0xBA, 0xB2, 0xE2, 0xCA, 0xD4, 0xCA, 0xE9, 0xC3, 0xFB]);
  const rawU8 = new TextDecoder('utf-8', { fatal: false }).decode(gbb);
  ok('ENC GBK 字节按 UTF-8 解会乱码(含替换符)', rawU8.indexOf('\uFFFD') >= 0);
  let gbSupport = true; try { new TextDecoder('gb18030'); } catch (e) { gbSupport = false; }
  if (gbSupport) {
    const dG = SI.decodeTxt(gbb);
    eq('ENC 回退后 encoding', dG.encoding, 'GB18030');
    ok('ENC GB18030 解码无替换符', dG.text.indexOf('\uFFFD') < 0, dG.text);
  } else { log('  SKIP GB18030（运行时无该解码器）'); }

  /* ============ B 组：端到端落库 ============ */
  log('== B1 structured 建新 ==');
  const ad = makeAdapter();
  await DB.init(ad);
  const b1 = await DA.importBook({ db: DB, adapter: ad }, { mode: 'new', format: 'structured', text: SAMPLE });
  eq('B1 返回 chapters', b1.chapters, 5);
  eq('B1 返回 sections', b1.sections, 2);
  eq('B1 返回 mode', b1.mode, 'new');
  eq('B1 返回 format=split（structured 旧名归一）', b1.format, 'split');
  const rb1 = await DA.readBundle({ db: DB }, b1.bookId);
  eq('B1 书名来自封面头', rb1.book.title, '瞌睡虫的美梦');
  eq('B1 作者来自封面头', rb1.book.author, 'qd');
  eq('B1 readBundle 章数', rb1.chapters.length, 5);
  const chs1 = await DB.listChapters(b1.bookId);
  eq('B1 章 idx=1..5', chs1.map(c => c.idx), [1, 2, 3, 4, 5]);
  ok('B1 章标题去前缀', chs1.every(c => c.title === '章标题'), chs1.map(c => c.title).join(','));
  eq('B1 首章 word_count>0', chs1[0].word_count > 0, true);
  ok('B1 空章(2..5) word_count=0', chs1.slice(1).every(c => c.word_count === 0));
  const secs1 = await DB.listSections(chs1[0].id);
  eq('B1 首章节 idx=1..2', secs1.map(s => s.idx), [1, 2]);
  eq('B1 节 chapter_id 指向首章', secs1.every(s => s.chapter_id === chs1[0].id), true);
  eq('B1 节 book_id 一致', secs1.every(s => String(s.book_id) === String(b1.bookId)), true);
  ok('B1 节标题去前缀', secs1.every(s => s.title === '节标题'), secs1.map(s => s.title).join(','));
  const s0 = await DB.getSection(secs1[0].id);
  ok('B1 节正文完整落库', s0.body.indexOf('记得极地') >= 0 && s0.body.indexOf('寿命') >= 0, s0.body);
  ok('B1 空章 body=""', (await DB.getChapter(chs1[1].id)).body === '');
  eq('B1 snapshots=0（首存跳过快照）', ad.db.prepare('SELECT COUNT(*) AS c FROM snapshots').get().c, 0);
  const otherSecs = await Promise.all(chs1.slice(1).map(c => DB.listSections(c.id)));
  ok('B1 节只挂首章，其余章 0 节', otherSecs.every(a => a.length === 0));

  log('== B2 structured 并入：追加且不动原章正文 ==');
  const seed = await DA.importBook({ db: DB, adapter: ad }, { mode: 'new', format: 'auto', text: '第一章 原有章节\n原正文XYZ' });
  const seedChs = await DB.listChapters(seed.bookId);
  const origBody = (await DB.getChapter(seedChs[0].id)).body;
  const mg = await DA.importBook({ db: DB, adapter: ad }, { mode: 'merge', format: 'structured', bookId: seed.bookId, text: SAMPLE });
  eq('B2 并入 mode', mg.mode, 'merge');
  eq('B2 追加 5 章', mg.appended, 5);
  eq('B2 并入 sections=2', mg.sections, 2);
  eq('B2 原第1章正文一字未动', (await DB.getChapter(seedChs[0].id)).body, origBody);
  const mgChs = await DB.listChapters(seed.bookId);
  eq('B2 章总数=6', mgChs.length, 6);
  eq('B2 新末章 idx=6', mgChs[mgChs.length - 1].idx, 6);
  const newFirst = mgChs.find(c => c.idx === 2);
  eq('B2 新节挂到新章(2 节)', (await DB.listSections(newFirst.id)).length, 2);
  eq('B2 原章仍 0 节', (await DB.listSections(seedChs[0].id)).length, 0);

  log('== B3 界面书名优先于封面头 ==');
  const b3 = await DA.importBook({ db: DB, adapter: ad }, { mode: 'new', format: 'structured', title: '界面书名', text: SAMPLE });
  eq('B3 书名=界面填写', (await DA.readBundle({ db: DB }, b3.bookId)).book.title, '界面书名');

  log('== B4 auto 回归：不建节 / 保留原始标题行 ==');
  const b4 = await DA.importBook({ db: DB, adapter: ad }, { mode: 'new', format: 'auto', text: '第一章 起\n内容一\n\n第二章 承\n内容二' });
  eq('B4 auto 2 章', b4.chapters, 2);
  eq('B4 auto 0 节', b4.sections, 0);
  eq('B4 auto format', b4.format, 'auto');
  const chs4 = await DB.listChapters(b4.bookId);
  ok('B4 保留原始标题行(含前缀)', chs4[0].title.indexOf('第一章') >= 0, chs4[0].title);
  ok('B4 未建任何节', (await DB.listSections(chs4[0].id)).length === 0);

  log('== B5 structured 遇无结构文本 reject 含「自动切分」 ==');
  await DA.importBook({ db: DB, adapter: ad }, { mode: 'new', format: 'structured', text: '这是一封没有章节标题的长信，只是普通正文。' })
    .then(() => ok('B5 应 reject', false), e => ok('B5 reject 文案含自动切分', /自动切分/.test(e.message), e && e.message));

  log('== B6 中途失败→imported=2/total=5，已成功章保留 ==');
  let cc = 0;
  const failDB = Object.create(DB);
  failDB.createChapter = function (bookId, title) {
    cc++;
    if (cc === 3) return Promise.reject(new Error('注入故障'));
    return DB.createChapter(bookId, title);
  };
  await DA.importBook({ db: failDB, adapter: ad }, { mode: 'new', format: 'structured', text: SAMPLE })
    .then(() => ok('B6 应 reject', false), e => {
      eq('B6 err.imported=2', e.imported, 2);
      eq('B6 err.total=5', e.total, 5);
    });
  const lastBook = ad.db.prepare('SELECT id FROM books ORDER BY id DESC LIMIT 1').get();
  eq('B6 已成功 2 章保留可重试', (await DB.listChapters(lastBook.id)).length, 2);

  /* ============ D 组：v2 新格式端到端落库（chapterOnly / sectionOnly） ============ */
  log('== D1 chapterOnly 端到端：只建章不建节，节标题行不丢字 ==');
  const d1 = await DA.importBook({ db: DB, adapter: ad }, { mode: 'new', format: 'chapterOnly', text: FTEXT });
  eq('D1 chapters=2', d1.chapters, 2);
  eq('D1 sections=0', d1.sections, 0);
  eq('D1 format', d1.format, 'chapterOnly');
  const d1chs = await DB.listChapters(d1.bookId);
  const d1secs = await Promise.all(d1chs.map(c => DB.listSections(c.id)));
  ok('D1 不建任何节', d1secs.every(a => a.length === 0));
  ok('D1 节标题行并入章正文', (await DB.getChapter(d1chs[0].id)).body.indexOf('第1节 一') >= 0, (await DB.getChapter(d1chs[0].id)).body);

  log('== D2 sectionOnly 并入目标章（§6 F-sec-target）==');
  const base = await DA.importBook({ db: DB, adapter: ad }, { mode: 'new', format: 'auto', text: '第一章 甲\n甲章原正文XYZ\n\n第二章 乙\n乙章原正文QRS' });
  const baseChs = await DB.listChapters(base.bookId);
  const target = baseChs[0], other = baseChs[1];
  const tBody0 = (await DB.getChapter(target.id)).body;
  const oBody0 = (await DB.getChapter(other.id)).body;
  const secText = '第1节 新增一\n\u3000\u3000新节正文一\n第2节 新增二\n\u3000\u3000新节正文二';
  const d2 = await DA.importBook({ db: DB, adapter: ad }, { mode: 'merge', format: 'sectionOnly', bookId: base.bookId, chapterId: target.id, text: secText });
  eq('D2 返回 sections=2', d2.sections, 2);
  eq('D2 返回 chapters=0(不建章)', d2.chapters, 0);
  eq('D2 返回 format', d2.format, 'sectionOnly');
  eq('D2 返回 chapterId=目标章', String(d2.chapterId), String(target.id));
  const d2secs = await DB.listSections(target.id);
  eq('D2 目标章新增 2 节', d2secs.length, 2);
  ok('D2 节 chapter_id 全等于目标章', d2secs.every(s => s.chapter_id === target.id));
  eq('D2 节 idx 续接 1,2', d2secs.map(s => s.idx).join(','), '1,2');
  eq('D2 目标章正文一字未动', (await DB.getChapter(target.id)).body, tBody0);
  eq('D2 其它章正文一字未动', (await DB.getChapter(other.id)).body, oBody0);
  eq('D2 其它章仍 0 节', (await DB.listSections(other.id)).length, 0);

  log('== D3 sectionOnly 缺目标章 reject ==');
  await DA.importBook({ db: DB, adapter: ad }, { mode: 'merge', format: 'sectionOnly', bookId: base.bookId, text: secText })
    .then(() => ok('D3 应 reject', false), e => ok('D3 缺章 reject 文案', /目标章节|选择目标/.test(e.message), e && e.message));

  ad.close();
  log('');
  log(`合计：${pass} 通过 / ${fail} 失败`);
  fs.writeFileSync(path.join(__dirname, 'report-m9-structured.txt'), out.join('\n') + '\n', 'utf8');
  console.log(out.join('\n'));
  console.log('通过 ' + pass + ' 失败 ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch(e => {
  fs.writeFileSync(path.join(__dirname, 'report-m9-structured.txt'), 'HARNESS ERROR: ' + (e && e.stack || e) + '\n' + out.join('\n'), 'utf8');
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exitCode = 2;
});
