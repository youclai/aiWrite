/* m11_update.test.cjs —— G1 版本检查与更新提醒无头自检（Node 侧，不上真机）
 * 覆盖：compareVersion 语义化比较边界；normalizeRelease 附件选取与发布页兜底；
 *       checkOnBoot 四态（update/latest/error/snoozed）与"失败静默不弹窗"；
 *       snoozeNow 写入 14 天冷却戳、冷却期内自动检查不发请求；manualCheck 忽略冷却且结果必有 toast。
 * 手法沿用本项目适配器注入：fetchJson 打桩 / 内存 store / 固定 now / 弹窗与 toast 回调记录。 */
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

const G = globalThis;
G.APP_VERSION = '1.0.0';   // index.html 的注入在 Node 侧由测试模拟

// ---------- 载入被测模块（updateConfig 提供配置单点，update 是被测件） ----------
new Function(sc('updateConfig.js'))(G);
new Function(sc('update.js'))(G);
const UP = G.NOVEL_UPDATE;
const IN = UP._internal;
const DAY = 86400000;

// ---------- 测试脚手架：内存 store / 打桩 fetch / 回调记录 ----------
function memStore(init) {
  const m = Object.assign({}, init || {});
  return { raw: m, get: k => (k in m ? m[k] : null), set: (k, v) => { m[k] = String(v); } };
}
let dialogCalls, toastCalls, fetchCalls, fetchImpl;
function harness(opts) {
  opts = opts || {};
  dialogCalls = []; toastCalls = []; fetchCalls = [];
  fetchImpl = opts.fetchJson || (() => Promise.reject(new Error('未打桩')));
  UP.setAdapters({
    fetchJson: (url, ms) => { fetchCalls.push({ url, ms }); return fetchImpl(url, ms); },
    store: opts.store || memStore(),
    now: opts.now || (() => 1700000000000),
    localVersion: () => opts.localVersion || '1.0.0',
    showDialog: pack => dialogCalls.push(pack),
    toast: (msg, kind) => toastCalls.push({ msg, kind })
  });
}
const REL = (tag, extra) => Object.assign({
  tag_name: tag, name: 'AI 写作助手 ' + tag, body: '## 更新内容\n1. 新增XX',
  html_url: 'https://gitee.com/wehello/aiWriting/releases/tag/' + tag,
  published_at: '2026-11-02T10:00:00+08:00',
  assets: [{ name: 'app-release.apk', browser_download_url: 'https://gitee.com/dl/' + tag + '.apk' }]
}, extra || {});

(async () => {
  /* ---------- 纯核心：compareVersion ---------- */
  log('== compareVersion ==');
  eq('远程更新返回 1', IN.compareVersion('1.0.0', 'v1.1.0'), 1);
  eq('本地更新返回 -1', IN.compareVersion('1.2.0', '1.1.9'), -1);
  eq('相同返回 0', IN.compareVersion('2.0.0', 'v2.0.0'), 0);
  eq('段数不足按 0 补齐', IN.compareVersion('1.0', '1.0.0'), 0);
  eq('数字比较非字符串（1.10>1.9）', IN.compareVersion('1.9.0', '1.10.0'), 1);
  eq('patch 位生效', IN.compareVersion('1.0.1', '1.0.2'), 1);
  eq('非法段按 0 不抛错', IN.compareVersion('x.y.z', '1.0.0'), 1);

  /* ---------- 纯核心：normalizeRelease / apiUrl ---------- */
  log('== normalizeRelease / apiUrl ==');
  const cfg = G.UPDATE_CONFIG;
  const n1 = IN.normalizeRelease(REL('v1.1.0'), cfg);
  eq('取出版本号', n1.remoteVersion, 'v1.1.0');
  eq('APK 附件直链', n1.assetUrl, 'https://gitee.com/dl/v1.1.0.apk');
  eq('发布页取 html_url', n1.releaseUrl, 'https://gitee.com/wehello/aiWriting/releases/tag/v1.1.0');
  const n2 = IN.normalizeRelease({ tag_name: 'v2.0.0' }, cfg);
  eq('无附件时 assetUrl 为空串', n2.assetUrl, '');
  eq('无 html_url 兜底 releases/latest', n2.releaseUrl, 'https://gitee.com/wehello/aiWriting/releases/latest');
  eq('结构不符返回 null', IN.normalizeRelease({ foo: 1 }, cfg), null);
  eq('API 地址拼装', IN.apiUrl(cfg), 'https://gitee.com/api/v5/repos/wehello/aiWriting/releases/latest');

  /* ---------- 流程：启动检查四态 ---------- */
  log('== checkOnBoot ==');
  harness({ fetchJson: () => Promise.resolve(REL('v1.1.0')) });
  let r = await UP.checkOnBoot();
  eq('有新版本 status', r.status, 'update');
  eq('有新版本弹窗一次', dialogCalls.length, 1);
  eq('弹窗包携带远程版本与本地版本', [dialogCalls[0].info.remoteVersion, dialogCalls[0].localVersion], ['v1.1.0', '1.0.0']);
  eq('弹窗包携带配置（网盘链接可达）', !!dialogCalls[0].config.baidu.link, true);

  harness({ fetchJson: () => Promise.resolve(REL('v1.0.0')) });
  r = await UP.checkOnBoot();
  eq('同版本 status=latest', r.status, 'latest');
  eq('同版本不弹窗', dialogCalls.length, 0);

  harness({ fetchJson: () => Promise.resolve(REL('v0.9.0')) });
  await UP.checkOnBoot();
  eq('本地更新不弹窗（降级不报错）', dialogCalls.length, 0);

  harness({ fetchJson: () => Promise.reject(new Error('network down')) });
  r = await UP.checkOnBoot();
  eq('网络失败 status=error', r.status, 'error');
  eq('网络失败静默（无弹窗无 toast）', [dialogCalls.length, toastCalls.length], [0, 0]);

  harness({ fetchJson: () => Promise.resolve({}) });
  r = await UP.checkOnBoot();
  eq('脏返回体判 error 不崩溃', [r.status, r.why], ['error', 'bad-payload']);

  /* ---------- 流程：冷却期 14 天 ---------- */
  log('== snooze ==');
  const st = memStore();
  harness({ store: st, fetchJson: () => Promise.resolve(REL('v1.1.0')) });
  await UP.checkOnBoot();                       // 先触发一次更新弹窗
  UP.snoozeNow();                               // 用户点「14天内不提醒」
  eq('冷却戳 = now + 14 天', Number(st.raw[IN.SNOOZE_KEY]), 1700000000000 + 14 * DAY);
  harness({ store: st, fetchJson: () => Promise.resolve(REL('v1.1.0')) });
  r = await UP.checkOnBoot();
  eq('冷却期内自动检查跳过', [r.status, r.why], ['skip', 'snoozed']);
  eq('冷却期内不发网络请求', fetchCalls.length, 0);
  r = await UP.manualCheck();                   // 手动检查忽略冷却
  eq('手动检查无视冷却', r.status, 'update');
  eq('手动检查发了请求并弹窗', [fetchCalls.length, dialogCalls.length], [1, 1]);
  // 过期冷却自动清理：戳已旧于当前时间 → 判定不静默且脏值归零
  const st2 = memStore({ [IN.SNOOZE_KEY]: String(1000) });
  harness({ store: st2, now: () => 2000, fetchJson: () => Promise.resolve(REL('v1.0.0')) });
  r = await UP.checkOnBoot();
  eq('过期冷却不再拦截', r.status, 'latest');
  eq('过期脏值顺手清零', st2.raw[IN.SNOOZE_KEY], '0');

  /* ---------- 流程：手动检查的结果 toast ---------- */
  log('== manualCheck toast ==');
  harness({ fetchJson: () => Promise.resolve(REL('v1.0.0')) });
  await UP.manualCheck();
  eq('无更新 toast 最新', [toastCalls.length, toastCalls[0].kind], [1, 'ok']);
  harness({ fetchJson: () => Promise.reject(new Error('请求超时')) });
  await UP.manualCheck();
  eq('失败 toast 不静默', [toastCalls.length, toastCalls[0].kind, toastCalls[0].msg.includes('请求超时')], [1, 'bad', true]);

  /* ---------- 配置缺失：skip 不发请求 ---------- */
  log('== 无配置降级 ==');
  const savedCfg = G.UPDATE_CONFIG;
  delete G.UPDATE_CONFIG;
  harness({ fetchJson: () => Promise.resolve(REL('v1.1.0')) });
  r = await UP.checkOnBoot();
  eq('无配置 status=skip', [r.status, fetchCalls.length, dialogCalls.length], ['skip', 0, 0]);
  G.UPDATE_CONFIG = savedCfg;

  const failed = fail;
  log('');
  log(`合计：${pass} 通过 / ${failed} 失败`);
  fs.writeFileSync(path.join(__dirname, 'report-m11-update.txt'), out.join('\n') + '\n', 'utf8');
  console.log('通过 ' + pass + ' 失败 ' + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  fs.writeFileSync(path.join(__dirname, 'report-m11-update.txt'), 'HARNESS ERROR: ' + (e && e.stack || e) + '\n' + out.join('\n'), 'utf8');
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
