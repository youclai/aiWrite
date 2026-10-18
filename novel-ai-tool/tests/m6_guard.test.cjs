/* m6_guard.test.cjs —— M6-g 草稿守卫 draftGuard.js 的无头自检（Node，假时钟 + 可控 save）
 * 逐条证明三条硬保证：单飞合并不双写 / 在途改动自动续存最新值 / 失败保脏可重试；外加防抖合并、
 * onState 状态次序、bindVisibility 隐藏即落盘。视图与全局事件只是薄接线（需真机目视，不在本轮）。 */
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
const tick = () => new Promise(r => setImmediate(r));   // 冲掉 .then 微任务链
const G = globalThis;

// 假时钟：手动 advance 触发到期定时器
function makeClock(start) {
  let now = start || 0, seq = 1; const timers = new Map();
  return {
    setTimer(fn, ms) { const id = seq++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let pick = null;
        for (const [id, t] of timers) if (t.at <= target && (!pick || t.at < pick.t.at)) pick = { id, t };
        if (!pick) break;
        now = pick.t.at; timers.delete(pick.id); pick.t.fn();
      }
      now = target;
    }
  };
}
// 可控 save：记录调用与并发，由测试决定何时 resolve/reject
function makeSave() {
  const s = { calls: [], pend: [], inflight: 0, max: 0, mode: 'ok' };
  s.fn = v => {
    s.calls.push(v); s.inflight++; s.max = Math.max(s.max, s.inflight);
    return new Promise((res, rej) => {
      s.pend.push((arg) => { s.inflight--; if (arg instanceof Error) rej(arg); else res(arg == null ? String(v).length : arg); });
    });
  };
  s.settleAll = () => { const p = s.pend.splice(0); p.forEach(f => f()); };
  s.settleFirst = () => { if (s.pend.length) s.pend.shift()(); };
  s.failFirst = (err) => { if (s.pend.length) s.pend.shift()(err || new Error('boom')); };
  return s;
}

(async () => {
  new Function(sc('draftGuard.js'))(G);
  const GU = G.NOVEL_DRAFT_GUARD;

  log('== 缺 save 构造即拒 ==');
  try { GU.create({}); ok('无 save 应抛', false); } catch (e) { ok('无 save 抛错', true); }

  log('== 干净时 flushNow 不写 ==');
  {
    const sv = makeSave(); const clock = makeClock();
    const g = GU.create({ save: sv.fn, debounce: 100, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const r = await g.flushNow();
    eq('clean 返回 saved=false', r, { saved: false, reason: 'clean' });
    eq('未触发 save', sv.calls, []);
    ok('非脏', g.isDirty() === false);
  }

  log('== 防抖：窗口内多次编辑合并成一次最新落盘 ==');
  {
    const sv = makeSave(); const clock = makeClock();
    const g = GU.create({ save: sv.fn, debounce: 100, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    g.mark('x'); clock.advance(50); g.mark('yyy');
    clock.advance(60); await tick();          // 到 100 触发 pump，取最新值 'yyy'
    eq('只存一次且为最新', sv.calls, ['yyy']);
    sv.settleAll(); await tick();
    ok('落盘后不脏', g.isDirty() === false);
  }

  log('== 单飞 + 在途续存：并发 flush 不双写，落盘后再存最新 ==');
  {
    const sv = makeSave(); const clock = makeClock();
    const g = GU.create({ save: sv.fn, debounce: 100, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    g.mark('aaa');
    const p1 = g.flushNow();                  // 启动在途（save 将在微任务里被调）
    g.mark('bbbb');                           // 在途期间又编辑
    const p2 = g.flushNow();                  // 合并到同一在途，不另发
    await tick();                             // save('aaa') 真正发生
    ok('并发合并：p2 与 p1 同一 promise', p1 === p2 || sv.calls.length === 1);
    eq('首轮只发了 aaa', sv.calls, ['aaa']);
    eq('并发峰值=1', sv.max, 1);
    sv.settleFirst(); await tick();           // 完成 aaa → 续存 bbbb
    eq('续存发出 bbbb', sv.calls, ['aaa', 'bbbb']);
    sv.settleAll(); await tick();
    ok('全部落定后不脏', g.isDirty() === false);
    eq('并发峰值仍=1', sv.max, 1);
  }

  log('== 失败保脏：save 失败不清脏，下次触发重试 ==');
  {
    const sv = makeSave(); const clock = makeClock();
    const g = GU.create({ save: sv.fn, debounce: 0, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    g.mark('q');
    const r1 = await (async () => { const pr = g.flushNow(); await tick(); sv.failFirst(); return pr; })();
    eq('失败返回 saved=false', r1.saved, false);
    ok('失败后仍脏', g.isDirty() === true);
    // 重试：同一值再 flush，这次成功
    const pr2 = g.flushNow(); await tick(); sv.settleAll(); const r2 = await pr2;
    eq('重试成功', r2.saved, true);
    ok('成功后不脏', g.isDirty() === false);
    eq('save 收到两次 q（首次失败+重试）', sv.calls, ['q', 'q']);
  }

  log('== onState 状态次序 ==');
  {
    const sv = makeSave(); const clock = makeClock(); const seen = [];
    const g = GU.create({ save: sv.fn, debounce: 0, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onState: st => seen.push(st.saved ? 'saved' : st.saving ? 'saving' : st.error ? 'error' : st.dirty ? 'dirty' : '?') });
    g.mark('hi'); const pr = g.flushNow(); await tick(); sv.settleAll(); await pr;
    eq('dirty→saving→saved', seen, ['dirty', 'saving', 'saved']);
  }

  log('== bindVisibility：页面隐藏即落盘 ==');
  {
    const sv = makeSave(); const clock = makeClock();
    const g = GU.create({ save: sv.fn, debounce: 5000, setTimer: clock.setTimer, clearTimer: clock.clearTimer }); // 防抖很久，靠隐藏触发
    const doc = { hidden: false, _h: null, addEventListener(ev, h) { this._h = h; }, removeEventListener() { this._h = null; } };
    const unbind = g.bindVisibility(doc);
    g.mark('zzz');
    doc.hidden = true; doc._h(); await tick();
    eq('隐藏触发落盘', sv.calls, ['zzz']);
    sv.settleAll(); await tick();
    ok('落盘后不脏', g.isDirty() === false);
    unbind();
    ok('解绑后清空监听', doc._h === null);
    // 无 addEventListener 的假 doc 优雅返回 no-op
    eq('无事件对象返回 no-op', typeof g.bindVisibility({}), 'function');
  }

  log(''); log(`合计：${pass} 通过 / ${fail} 失败`);
  fs.writeFileSync(path.join(__dirname, 'report-m6-guard.txt'), out.join('\n') + '\n', 'utf8');
  console.log('通过 ' + pass + ' 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  fs.writeFileSync(path.join(__dirname, 'report-m6-guard.txt'), 'HARNESS ERROR: ' + (e && e.stack || e) + '\n' + out.join('\n'), 'utf8');
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
