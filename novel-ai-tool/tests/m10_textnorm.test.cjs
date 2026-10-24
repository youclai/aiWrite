/* m10_textnorm.test.cjs —— 规范文本纯函数（优化批次 E）回归（Node 侧）
   规则：每段前两个全角空格、段间单 \n、空段丢弃、\r\n归一、幂等、不删字。
   运行：node tests/m10_textnorm.test.cjs ；退出码 0=全绿。 */
const fs = require('node:fs');
const path = require('node:path');

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

(async () => {
  const G = globalThis;
  new Function(sc('textNorm.js'))(G);
  const TN = G.NOVEL_TEXT_NORM;
  ok('NOVEL_TEXT_NORM 已加载', TN && typeof TN.normalize === 'function');
  const ID = '\u3000\u3000';

  // 1) 多段 + 空行折叠：三段中间夹空行 → 恰三段、各前两全角、单 \n 连接
  const r1 = TN.normalize('第一段。\n\n  \n第二段。\n第三段。');
  eq('T1 段数', r1.count, 3);
  eq('T1 逐段缩进+单换行', r1.text, ID + '第一段。\n' + ID + '第二段。\n' + ID + '第三段。');

  // 2) 旧缩进剥除后统一：已有全角缩进/半角空格/制表符 → 全变恰两全角（幂等前件）
  const r2 = TN.normalize(ID + '已有缩进。\n    半角四空格。\n\t制表符缩进。');
  eq('T2 混合缩进归一', r2.text, ID + '已有缩进。\n' + ID + '半角四空格。\n' + ID + '制表符缩进。');
  eq('T2 段数', r2.count, 3);

  // 3) 幂等：二次执行结果与首次完全相同
  const r3 = TN.normalize(r1.text);
  eq('T3 幂等-文本', r3.text, r1.text);
  eq('T3 幂等-段数', r3.count, r1.count);
  const r3b = TN.normalize(r3.text);
  eq('T3 幂等-三次', r3b.text, r1.text);

  // 4) \r\n 与 \r 归一
  eq('T4 CRLF', TN.normalize('甲\r\n乙\r丙').text, ID + '甲\n' + ID + '乙\n' + ID + '丙');

  // 5) 行尾空白/全角空格/NBSP 剥掉，字不丢
  eq('T5 行尾清理', TN.normalize('  甲    \u3000\u00a0\n乙 \u00a0 ').text, ID + '甲\n' + ID + '乙');

  // 6) 无换行单段：整段视为一段
  eq('T6 单段', TN.normalize('只有一段话。').text, ID + '只有一段话。');

  // 7) 空文本/纯空白：count=0、空串
  eq('T7 空串', TN.normalize('').text, '');
  eq('T7 空串-count', TN.normalize('').count, 0);
  eq('T7 纯空白', TN.normalize('  \n\t\n \u3000 ').count, 0);
  eq('T7 null 容错', TN.normalize(null).count, 0);

  // 8) 不删任何字：去掉空白后字符序列保持（仅缩进符为新增）
  const src = '甲段，含标点！\n\n乙段——破折号。\n丙段「引号」';
  const got = TN.normalize(src).text;
  const strip = s => s.replace(/[\s\u3000]/g, '');
  eq('T8 一字不删', strip(got), strip(src));

  // 9) 中文句读/emoji 原样保留
  eq('T9 特殊字符', TN.normalize('测试\u{1F600}😀！').text, ID + '测试\u{1F600}😀！');

  const failed = fail;
  console.log(out.join('\n'));
  console.log(`\n[单测] 通过 ${pass} 失败 ${failed}`);
  fs.writeFileSync(path.join(__dirname, 'report-m10-textnorm.txt'), out.join('\n') + `\n\n合计 ${pass + failed} 项，失败 ${failed} 项。\n`, 'utf8');
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
