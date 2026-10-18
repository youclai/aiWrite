/* m6_actions.test.cjs —— M6 UI 胶水层 dataActions.js 的端到端无头自检（Node，node:sqlite + 真实 temp fs）
 * 证明 views.js 只是薄壳：导出四格式/导入/备份/恢复(含 safety)/存储统计 全靠 dataActions 组合已跑绿的逻辑件。
 * temp 用带 writeBytes/readBytes 的 node fs 适配器，二进制产物落真实磁盘再读回校验。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['schema.js', 'db.js', 'tempStore.js', 'zip.js', 'exporter.js', 'importer.js', 'zipper.js', 'docx.js', 'backup.js', 'storage.js', 'dataActions.js'];
const sc = f => fs.readFileSync(path.join(ROOT, 'www/js', f), 'utf8');
const out = [];
let pass = 0, fail = 0;
const log = (...a) => out.push(a.join(' '));
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; log(`  PASS ${name}`); }
  else { fail++; log(`  FAIL ${name}\n       got : ${g}\n       want: ${w}`); }
};
const ok = (name, cond, hint) => eq(name, !!cond, true, hint);
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
// 带二进制的 node fs temp 适配器
function makeNodeFs(rootDir) {
  const abs = rel => path.join(rootDir, rel);
  return {
    ensureDir: rel => { fs.mkdirSync(abs(rel), { recursive: true }); return true; },
    writeFile: (rel, content) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), content, 'utf8'); },
    writeBytes: (rel, u8) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), Buffer.from(u8)); },
    readFile: rel => fs.readFileSync(abs(rel), 'utf8'),
    readBytes: rel => new Uint8Array(fs.readFileSync(abs(rel))),
    exists: rel => fs.existsSync(abs(rel)),
    readdir: rel => fs.readdirSync(abs(rel), { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() })),
    deleteFile: rel => { fs.rmSync(abs(rel), { force: true }); },
    removeDir: rel => { fs.rmSync(abs(rel), { recursive: true, force: true }); },
    stat: rel => ({ size: fs.statSync(abs(rel)).size })
  };
}

(async () => {
  for (const f of FILES) new Function(sc(f))(G);
  const DB = G.NOVEL_DB, TMP = G.NOVEL_TEMP, DA = G.NOVEL_DATA_ACTIONS, ZIP = G.NOVEL_ZIP, IMP = G.NOVEL_IMPORTER;

  const ad = makeAdapter();
  await DB.init(ad);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-act-'));
  await TMP.init(makeNodeFs(tmpRoot));
  const deps = { db: DB, adapter: ad, temp: TMP };

  // 造一本书：2 章 + 1 角色
  const bookId = await DB.createBook({ title: '风与尘', author: '甲', synopsis: '简介句' });
  const c1 = await DB.createChapter(bookId, '第一章 开端');
  const c2 = await DB.createChapter(bookId, '第二章 发展');
  await DB.saveChapterBody(c1, '风起了。', 'create');
  await DB.saveChapterBody(c2, '尘土飞扬不止。', 'create');
  await DB.saveCharacter(bookId, { name: '李某', role: '剑客' });

  log('== 导出 txt ==');
  const exTxt = await DA.exportBook(deps, { bookId, format: 'txt' });
  eq('txt 文件名=书名.txt', exTxt.files[0].name, '风与尘.txt');
  eq('bundle.chapters=2', exTxt.bundle.chapters, 2);
  eq('bundle.words=9(4+5? 实际字数)', exTxt.bundle.words, (await DB.getChapter(c1)).word_count + (await DB.getChapter(c2)).word_count);
  const txtBack = await TMP.read('export', '风与尘.txt');
  ok('txt 以 BOM 开头', txtBack.charCodeAt(0) === 0xFEFF, txtBack.charCodeAt(0));
  ok('txt 含两章正文', txtBack.indexOf('风起了') >= 0 && txtBack.indexOf('尘土飞扬不止') >= 0);
  ok('txt 含前言(书名/作者/简介)', txtBack.indexOf('风与尘') >= 0 && txtBack.indexOf('简介句') >= 0);

  log('== 导出 txt + 分章 ==');
  const exSplit = await DA.exportBook(deps, { bookId, format: 'txt', splitChapters: true });
  ok('分章共 1 全本 + 2 分章 = 3 文件', exSplit.files.length === 3, exSplit.files.length);
  ok('分章文件落盘', await TMP.exists('export', '风与尘/分章/01 第一章 开端.txt'));

  log('== 导出 docx（二进制落盘再读回）==');
  const exDocx = await DA.exportBook(deps, { bookId, format: 'docx' });
  eq('docx 文件名', exDocx.files[0].name, '风与尘.docx');
  ok('docx 落盘', await TMP.exists('export', '风与尘.docx'));
  const docxBytes = await TMP.readBytes('export', '风与尘.docx');
  const docxNames = ZIP.list(docxBytes).map(e => e.name);
  ok('docx 六部件齐全', ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/header1.xml'].every(n => docxNames.includes(n)), docxNames.join(','));

  log('== 导出 作品包 zip ==');
  const exZip = await DA.exportBook(deps, { bookId, format: 'zip' });
  eq('zip 文件名', exZip.files[0].name, '风与尘.zip');
  const zipBytes = await TMP.readBytes('export', '风与尘.zip');
  const zipNames = ZIP.list(zipBytes).map(e => e.name);
  ok('zip 含全本txt+角色卡+结构', zipNames.includes('风与尘.txt') && zipNames.includes('风与尘/角色卡.md') && zipNames.includes('风与尘/章节结构.md'), zipNames.join(','));

  log('== 导入建书（按章 / 按空行）==');
  const imp1 = await DA.importBook(deps, { title: '导入章', text: '第一章 起\n内容一\n\n第二章 承\n内容二' });
  eq('章标题文本导入=2 章', imp1.chapters, 2);
  const imp2 = await DA.importBook(deps, { title: '导入块', text: '段落一\n\n段落二\n\n段落三' });
  eq('无章标题按空行=3 章', imp2.chapters, 3);
  const impChs = await DB.listChapters(imp1.bookId);
  const firstBody = (await DB.getChapter(impChs[0].id)).body;
  ok('导入正文无损含"内容一"', firstBody.indexOf('内容一') >= 0, firstBody);
  await DA.importBook(deps, { title: '空', text: '   ' }).then(() => ok('空内容应 reject', false), () => ok('空内容 reject', true));

  log('== 备份（密钥剔除 + safety）==');
  await DB.setSetting('api', { provider: 'mock', api_key: 'sk-LEAK-ME-999', access_token: 'ZZtokVAL-777' });
  const bk = await DA.backupNow(deps, { book_title: '风与尘' });
  ok('备份名 backup_*.zip', /^backup_\d{8}-\d{6}\.zip$/.test(bk.name), bk.name);
  ok('备份落 temp/backup', await TMP.exists('backup', bk.name));
  ok('manifest 记录剔除字段含 api_key', (bk.manifest.redacted_secret_fields || []).includes('api_key'), JSON.stringify(bk.manifest.redacted_secret_fields));
  const bkScan = G.NOVEL_BACKUP.scanSecrets(await TMP.readBytes('backup', bk.name), ['sk-LEAK-ME-999', 'ZZtokVAL-777']);
  eq('盘上备份包查不到明文密钥', bkScan, []);
  ok('bk.bytes 为字节数(>0)', typeof bk.bytes === 'number' && bk.bytes > 0, bk.bytes);

  log('== listBackups 倒序 ==');
  const lst = await DA.listBackups(deps);
  ok('至少 1 个备份', lst.length >= 1, lst.length);
  ok('首项即刚备份', lst[0].name === bk.name, lst[0].name);

  log('== 恢复（先 safety 快照，再无损回滚当前库）==');
  // 备份后又加一本书 → 恢复应回到"当时"的书数，并生成 safety_*.zip
  const booksBeforeRestore = (await DB.listBooks()).length;
  await DB.createBook({ title: '备份之后新建' });
  const midCount = (await DB.listBooks()).length;
  ok('中途多了一本', midCount === booksBeforeRestore + 1, midCount);
  const rs = await DA.restoreFrom(deps, { name: bk.name });
  ok('恢复 ok', rs.ok === true, JSON.stringify(rs));
  ok('恢复含 safety 前置', rs.order && rs.order[0] === 'safety', JSON.stringify(rs.order));
  eq('恢复后书数回到备份时', (await DB.listBooks()).length, bk.manifest.counts.books);
  ok('生成了 safety_*.zip', (await DA.listBackups(deps)).some(f => /^safety_/.test(f.name)));
  // 恢复的书内容仍在
  const names = (await DB.listBooks()).map(b => b.title);
  ok('恢复后仍有《风与尘》', names.includes('风与尘'), names.join(','));
  ok('恢复后 api_key 已被剔（值替换）', JSON.stringify(await DB.getSetting('api')).indexOf('sk-LEAK-ME-999') < 0);

  log('== 存储统计 ==');
  const rep = await DA.storageReport(deps, {});
  eq('统计 tables.books 与库一致', rep.tables.books, (await DB.listBooks()).length);
  ok('统计 temp 已并入', rep.temp && rep.temp.total.files > 0, rep.temp && rep.temp.total.files);
  ok('库体积>0', rep.database.bytes > 0);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  ad.close();

  log(''); log(`合计：${pass} 通过 / ${fail} 失败`);
  fs.writeFileSync(path.join(__dirname, 'report-m6-actions.txt'), out.join('\n') + '\n', 'utf8');
  console.log('通过 ' + pass + ' 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  fs.writeFileSync(path.join(__dirname, 'report-m6-actions.txt'), 'HARNESS ERROR: ' + (e && e.stack || e) + '\n' + out.join('\n'), 'utf8');
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
