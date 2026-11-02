/* 版本检查与更新提醒（G1）：应用启动后查询 Gitee 最新 Release，仅比对版本号决定是否弹窗；
   只发一个匿名只读 GET（不携带设备信息/作品数据/任何标识），网络失败/超时静默跳过，绝不影响启动。
   架构沿用本项目「纯 Web 核心 + 适配器注入」：core 内全是可脱离浏览器验证的纯函数，
   传输（fetch）、存储（localStorage）、时间、UI 回调都可经 setAdapters 替换——Node 测试即以此自验。
   依赖（均为运行时取用，加载顺序不敏感）：UPDATE_CONFIG（配置）、APP_VERSION（index.html 注入）、
   NOVEL_VIEWS.showUpdateDialog（弹窗）、NOVEL_APP.toast（提示）。 */
(function (root) {
  'use strict';

  var SNOOZE_KEY = 'novel.update.snoozeUntil';   // 本地存储键：忽略提醒的到期毫秒时间戳
  var DEFAULT_SNOOZE_DAYS = 14;                  // 配置缺失时的兜底冷却期
  var DEFAULT_TIMEOUT_MS = 5000;                 // 配置缺失时的兜底超时

  /* ---------- 默认适配器 ---------- */

  // 键值存储：优先 localStorage（Capacitor WebView 与浏览器预览都可用且持久）；
  // 环境缺失（如隐私模式抛异常/Node）时降级为内存 Map，保证主流程不因存储而崩。
  function defaultStore() {
    var mem = {};
    var ls = null;
    try {
      ls = root.localStorage || null;
      if (ls) { ls.setItem('novel.probe', '1'); ls.removeItem('novel.probe'); }
    } catch (e) { ls = null; }
    if (!ls) {
      return {
        get: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        set: function (k, v) { mem[k] = String(v); }
      };
    }
    return {
      get: function (k) { try { return ls.getItem(k); } catch (e) { return mem[k] !== undefined ? mem[k] : null; } },
      set: function (k, v) { try { ls.setItem(k, String(v)); } catch (e) { mem[k] = String(v); } }
    };
  }

  // 只读 GET 取 JSON：5s 超时（AbortController 可用时真中断请求，否则仅定时拒绝、悬挂请求由系统回收）。
  function defaultFetchJson(url, timeoutMs) {
    if (typeof root.fetch !== 'function') return Promise.reject(new Error('本机不支持网络请求'));
    var timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
    var ctl = root.AbortController ? new root.AbortController() : null;
    var req = root.fetch(url, { method: 'GET', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (ctl) { try { ctl.abort(); } catch (e) {} }
        reject(new Error('请求超时'));
      }, timeout);
      req.then(function (d) {
        if (done) return;
        done = true; clearTimeout(timer); resolve(d);
      }, function (e) {
        if (done) return;
        done = true; clearTimeout(timer); reject(e);
      });
    });
  }

  var A = {   // 当前适配器集合；App 运行时用默认值，Node 测试/降级路径通过 setAdapters 注入
    fetchJson: defaultFetchJson,
    store: defaultStore(),
    now: function () { return Date.now(); },
    localVersion: function () { return String(root.APP_VERSION || '0.0.0'); },
    showDialog: function (pack) {
      var V = root.NOVEL_VIEWS;
      if (V && V.showUpdateDialog) V.showUpdateDialog(pack);
    },
    toast: function (msg, kind) {
      var app = root.NOVEL_APP;
      if (app && app.toast) app.toast(msg, kind);
    }
  };

  /* ---------- 纯核心（可在 Node 直接调用自验） ---------- */

  // 语义化版本比较：去掉前导 v 后逐段比数字；远程更新返回 1，本地更新返回 -1，相同返回 0。
  // 段数不足按 0 补齐（"1.0" == "1.0.0"），非法段（NaN）也按 0 处理，保证比较永不抛错。
  function compareVersion(local, remote) {
    var l = String(local || '').replace(/^v/i, '').split('.');
    var r = String(remote || '').replace(/^v/i, '').split('.');
    for (var i = 0; i < 3; i++) {
      var a = Number(l[i]) || 0, b = Number(r[i]) || 0;
      if (b > a) return 1;
      if (b < a) return -1;
    }
    return 0;
  }

  // 归一化 Gitee Release API 返回：取出版本号、更新日志、APK 附件直链与发布页兜底链接。
  // 结构不符（无 tag_name）返回 null，由调用方按“静默跳过”处理。
  function normalizeRelease(json, config) {
    if (!json || !json.tag_name) return null;
    var g = (config && config.gitee) || {};
    var assets = json.assets || [], apk = null;
    for (var i = 0; i < assets.length; i++) {
      var n = String((assets[i] && assets[i].name) || '');
      if (/\.apk$/i.test(n)) { apk = assets[i]; break; }
    }
    var base = 'https://gitee.com/' + (g.owner || '') + '/' + (g.repo || '');
    return {
      remoteVersion: String(json.tag_name),
      title: String(json.name || ''),
      changelog: String(json.body || ''),
      assetUrl: apk ? String(apk.browser_download_url || '') : '',
      releaseUrl: String(json.html_url || (base + '/releases/latest')),
      publishedAt: String(json.published_at || '')
    };
  }

  // 冷却期判定：存储中的到期时间戳未过则静默；已过期顺手清掉，避免脏值长期滞留。
  function isSnoozed(store, now) {
    var until = Number(store.get(SNOOZE_KEY) || 0);
    if (until > 0 && now < until) return true;
    if (until > 0) store.set(SNOOZE_KEY, '0');
    return false;
  }

  function snooze(store, now, days) {
    store.set(SNOOZE_KEY, String(now + days * 86400000));
  }

  function apiUrl(config) {
    var g = (config && config.gitee) || {};
    return 'https://gitee.com/api/v5/repos/' + encodeURIComponent(g.owner || '') + '/'
      + encodeURIComponent(g.repo || '') + '/releases/latest';
  }

  /* ---------- 流程编排 ---------- */

  // 执行一次检查。force=true（手动）忽略冷却期；返回状态对象，任何异常都在此收口、绝不外抛。
  function checkUpdate(force) {
    var cfg = root.UPDATE_CONFIG || null;
    var local = A.localVersion();
    if (!cfg || !cfg.gitee || !cfg.gitee.owner) {
      return Promise.resolve({ status: 'skip', why: 'no-config', localVersion: local });
    }
    if (!force && isSnoozed(A.store, A.now())) {
      return Promise.resolve({ status: 'skip', why: 'snoozed', localVersion: local });
    }
    return A.fetchJson(apiUrl(cfg), cfg.timeoutMs || DEFAULT_TIMEOUT_MS).then(function (json) {
      var rel = normalizeRelease(json, cfg);
      if (!rel) return { status: 'error', why: 'bad-payload', localVersion: local };
      var pack = { info: rel, localVersion: local, config: cfg };
      // compareVersion 返回 1 = 远程更新（见其注释约定），>0 才弹提醒
      return compareVersion(local, rel.remoteVersion) > 0
        ? Object.assign({ status: 'update' }, pack)
        : Object.assign({ status: 'latest' }, pack);
    }, function (e) {   // 网络失败/超时/非 200：静默降级，不打扰用户
      return { status: 'error', why: humanizeError(e), localVersion: local };
    });
  }

  // 把技术错误转成人话（手动检查的 toast 直接用它，用户不该看到 HTTP 状态码）：
  // 404 = 仓库尚无 Release（未发布/已改名/被转私有）；403/451 = 仓库不可访问；其余保留原文便于反馈排障。
  function humanizeError(e) {
    var msg = String((e && e.message) || e || '');
    if (/404/.test(msg)) return '发布仓库暂无已发布版本';
    if (/403|451/.test(msg)) return '发布仓库不可访问';
    return msg || '网络不可用';
  }

  // 启动检查：fire-and-forget，只有确认有新版本才弹层提醒，其余一律无声。
  function checkOnBoot() {
    return checkUpdate(false).then(function (r) {
      if (r.status === 'update') A.showDialog(r);
      return r;
    });
  }

  // 手动检查（「我的 › 检查更新」）：忽略冷却期，各结果都给明确 toast，失败不得静默。
  function manualCheck() {
    return checkUpdate(true).then(function (r) {
      if (r.status === 'update') { A.showDialog(r); return r; }
      if (r.status === 'latest') { A.toast('已是最新版本 v' + r.localVersion.replace(/^v/i, ''), 'ok'); return r; }
      if (r.status === 'skip') { A.toast('未配置更新检查', 'bad'); return r; }
      A.toast('检查失败：' + (r.why || '网络不可用') + '，请稍后重试', 'bad');
      return r;
    });
  }

  // 弹窗内点「14天内不提醒」：按配置天数写入本地冷却戳（仅存本机，不上传）。
  function snoozeNow() {
    var cfg = root.UPDATE_CONFIG || {};
    snooze(A.store, A.now(), cfg.snoozeDays || DEFAULT_SNOOZE_DAYS);
  }

  root.NOVEL_UPDATE = {
    checkOnBoot: checkOnBoot,
    manualCheck: manualCheck,
    snoozeNow: snoozeNow,
    setAdapters: function (patch) { Object.assign(A, patch || {}); },
    // 纯核心暴露给 Node 自验与探针（生产代码不依赖）
    _internal: {
      compareVersion: compareVersion,
      normalizeRelease: normalizeRelease,
      apiUrl: apiUrl,
      isSnoozed: isSnoozed,
      snooze: snooze,
      SNOOZE_KEY: SNOOZE_KEY
    }
  };
})(globalThis);
