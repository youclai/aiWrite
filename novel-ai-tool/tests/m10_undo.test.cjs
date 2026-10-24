/* m10_undo.test.cjs —— 会话内撤回/重做内存双栈（优化批次 F）回归（Node 侧）
   覆盖：基线/打字段合并、同文本去重、新 push 清 redo、上限丢最旧、程序化写回协议、
   canUndo 把“在打字未落栈”也算可撤、sel 随步存取。
   运行：node tests/m10_undo.test.cjs ；退出码 0=全绿。 */
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
const ok = (name, cond) => eq(name, !!cond, true);

(async () => {
  const G = globalThis;
  new Function(sc('undoStack.js'))(G);
  const UN = G.NOVEL_UNDO;
  ok('NOVEL_UNDO 已加载', UN && typeof UN.create === 'function');
  const sel = (a, b) => ({ start: a, end: b });

  /* U1 基线与空栈 */
  let u = UN.create({ max: 80 });
  u.reset('初始正文', sel(0, 0));
  ok('U1 刚 reset 不可撤', !u.canUndo('初始正文'));
  eq('U1 undo 返回 null', u.undo('初始正文', sel(0, 0)), null);
  eq('U1 redo 返回 null', u.redo('初始正文', sel(0, 0)), null);
  ok('U1 不可重做', !u.canRedo());

  /* U2 打字段：文本变了才产生历史步；同文本只跟随光标 */
  ok('U2 变化产生步', u.current('初始正文补', sel(5, 5)) === true);
  ok('U2 同文本不产生步', u.current('初始正文补', sel(6, 6)) === false);
  eq('U2 undo 栈深', u.sizes().undo, 1);
  const back = u.undo('初始正文补', sel(6, 6));
  eq('U2 撤销回旧基线', back.text, '初始正文');
  eq('U2 撤销带旧选区', [back.sel.start, back.sel.end], [0, 0]);
  eq('U2 撤销后 redo 可回', u.redo(back.text, back.sel).text, '初始正文补');

  /* U3 打字合并语义：连续多次 current 各成一步；同文本去重防“一步按两次” */
  u = UN.create({});
  u.reset('a');
  u.current('ab'); u.current('abc'); u.current('abc');   // 第三次与基线同文本→去重不加
  eq('U3 去重后栈深=2', u.sizes().undo, 2);
  eq('U3 第一次撤到 ab', u.undo('abc').text, 'ab');
  eq('U3 第二次撤到 a', u.undo('ab').text, 'a');
  eq('U3 第三次无历史', u.undo('a'), null);

  /* U4 新 push 清空 redo（标准双栈语义） */
  u = UN.create({});
  u.reset('x');
  u.current('y');
  const got = u.undo('y');
  ok('U4 撤销后可重做', u.canRedo());
  u.current('z', sel(1, 1));   // 撤销后又打字 → redo 作废
  ok('U4 新输入清空 redo', !u.canRedo());
  eq('U4 redo 返回 null', u.redo('z'), null);
  ok('U4 undo 仍可继续', !!u.undo('z'));

  /* U5 canUndo 带当前文本：正在打字但还没落栈也算可撤 */
  u = UN.create({});
  u.reset('base');
  ok('U5 未打字不可撤', !u.canUndo('base'));
  ok('U5 打字未落栈也可撤', u.canUndo('base+正在输入'));

  /* U6 上限丢最旧 */
  u = UN.create({ max: 3 });
  u.reset('s0');
  u.current('s1'); u.current('s2'); u.current('s3'); u.current('s4');   // 4 步历史，栈最多 3
  eq('U6 栈深封顶', u.sizes().undo, 3);
  eq('U6 丢最旧：连撤 3 步', [u.undo('s4').text, u.undo('s3').text, u.undo('s2').text], ['s3', 's2', 's1']);
  eq('U6 第 4 次撤销无 s0 之外历史', u.undo('s1'), null);

  /* U7 程序化写回协议（AI 采纳/规范文本）：Pre 存改前态 → Post 更新基线 → 撤销恰回改前 */
  u = UN.create({});
  u.reset('改前', sel(0, 2));
  u.programmaticPre('改前', sel(0, 2));
  u.programmaticPost('改后', sel(4, 4));
  eq('U7 撤销回改前态', u.undo('改后', sel(4, 4)).text, '改前');
  eq('U7 重做回改后态', u.redo('改前', sel(0, 2)).text, '改后');

  /* U8 programmaticPre 先冲在途打字段：打字未落栈即被程序化写回，撤销一步退到打字段前基线 */
  u = UN.create({});
  u.reset('A');
  u.current('Ab');                     // 打字（已落栈场景由 views 防抖触发，这里模拟已调 current）
  u.programmaticPre('Ab', sel(2, 2));  // 紧接着程序化写回前
  u.programmaticPost('C', sel(1, 1));
  eq('U8 撤回到打字后态', u.undo('C').text, 'Ab');
  eq('U8 再撤回到初始基线', u.undo('Ab').text, 'A');

  /* U9 sel 非法值钳制：负数/end<start 归一为 0,0 */
  u = UN.create({});
  u.reset('t', sel(-5, -2));
  const st9 = u.undo('t2');   // 在途打字段先经 current 落栈，再弹栈回改前态
  ok('U9 有可撤步', !!st9);
  eq('U9 文本回原基线', st9 && st9.text, 't');
  eq('U9 负选区钳为 0,0', st9 && [st9.sel.start, st9.sel.end], [0, 0]);

  const failed = fail;
  console.log(out.join('\n'));
  console.log(`\n[单测] 通过 ${pass} 失败 ${failed}`);
  fs.writeFileSync(path.join(__dirname, 'report-m10-undo.txt'), out.join('\n') + `\n\n合计 ${pass + failed} 项，失败 ${failed} 项。\n`, 'utf8');
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
