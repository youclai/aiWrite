/* 应用外壳与路由（M4-a，F53/F54）：三页签 SPA（写作/设定/我的），hash 路由承接系统返回键。
   无打包器约定：所有全局模块由 index.html 依序 <script> 注入。本文件不含具体界面，只做
   装配（boot→择传输→挂 shell→路由分发→切页前 flush 未保存），界面在 views.js。 */
(function (root) {
  'use strict';

  var DB = root.NOVEL_DB;

  var App = {
    // 运行态：当前作品/章节、离开编辑器时的待落盘回调（F54）
    state: { bookId: null, chapterId: null, flush: null, booted: false, report: null },
    el: null,          // #screen
    toastTimer: null,

    // 组装 session 依赖；transport 供真实 provider 走原生 AiStream，无则只允许 mock
    deps: function () {
      return {
        db: root.NOVEL_DB, prompt: root.NOVEL_PROMPT, providers: root.NOVEL_PROVIDERS,
        stream: root.NOVEL_STREAM, clean: root.NOVEL_CLEAN,
        consistence: root.NOVEL_CONSISTENCE, secure: root.NOVEL_SECURE
      };
    },

    nativeAiStream: function () {
      return root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.AiStream
        ? root.Capacitor.Plugins.AiStream : null;
    },

    // 当前 API 配置是否可用于真实 AI：必须已选真实 provider、已保存 Key，且原生 AiStream 可用。
    // 未配置（provider 缺失/mock，或没有 Key）时一律拦截并提示先配置——不再用 mock 静默回显
    // （mock 回显会让所有动作看起来一样、且串着“润色结果”字样，正是用户反馈的“结果串台”根因）。
    apiReady: function (api) {
      if (!api || !api.provider || api.provider === 'mock') return { ok: false, why: '请先在“我的 › AI 助手”里选择模型' };
      if (!api.key_set) return { ok: false, why: '请先在“我的 › AI 助手”里填入并保存 API Key' };
      if (!this.nativeAiStream()) return { ok: false, why: '真实模型需原生 AiStream 插件（尚未构建），暂无法联网' };
      return { ok: true };
    },

    /* ---------- 路由 ---------- */
    // 底部只剩两页签：写作(#/shelf) / 我的(#/me)。作品设定不再单独占页签，
    // 全部并入作品详情 #/book/:id 下的竖向分段（章节/人物/剧情/势力/信息），tab 段可选。
    routes: [
      { re: /^#\/shelf$/, view: 'shelf' },
      { re: /^#\/book\/(\d+)(?:\/([a-z]+))?$/, view: 'book', params: ['bookId', 'tab'] },
      { re: /^#\/chapter\/(\d+)$/, view: 'chapter', params: ['chapterId'] },
      { re: /^#\/editor\/(\d+)\/(\d+)$/, view: 'editor', params: ['bookId', 'chapterId'] },
      { re: /^#\/section\/(\d+)\/(\d+)$/, view: 'section', params: ['chapterId', 'sectionId'] },
      { re: /^#\/me(?:\/([a-z]+))?$/, view: 'me', params: ['tab'] }
    ],

    resolve: function (hash) {
      hash = hash || root.location.hash || '#/shelf';
      for (var i = 0; i < this.routes.length; i++) {
        var m = hash.match(this.routes[i].re);
        if (m) {
          var p = {};
          // 无 params 的路由（#/shelf、#/me）字段为 undefined，兜底空数组，否则 .forEach 抛错致整屏停在“加载中…”
          (this.routes[i].params || []).forEach(function (name, k) { p[name] = m[k + 1]; });
          return { view: this.routes[i].view, params: p, hash: hash };
        }
      }
      return { view: 'shelf', params: {}, hash: '#/shelf' };
    },

    go: function (hash) {
      if (root.location.hash === hash) this.render();   // 同页强制重绘
      else root.location.hash = hash;
    },

    // 切页前落盘未保存正文（F54）
    render: function () {
      if (this.state.flush) { try { this.state.flush(); } catch (e) { console.log('[app] flush 失败', e); } this.state.flush = null; }
      var r = this.resolve();
      var view = root.NOVEL_VIEWS[r.view];
      this.el.innerHTML = '';
      this.el.className = 'screen';   // 每路由复位：双栏屏由视图再加 .screen--dual，避免跨路由残留
      if (!view) { this.el.textContent = '未知界面：' + r.view; return; }
      var self = this;
      // 视图既支持注册为裸函数（现状），也兼容 {render} 对象；避免 view.render 对裸函数为 undefined 而崩溃
      var fn = (typeof view === 'function') ? view : (view && view.render);
      if (typeof fn !== 'function') { this.el.innerHTML = '<div class="err">界面不可调用：' + self.esc(r.view) + '</div>'; return; }
      Promise.resolve(fn.call(view, r.params)).then(function () { self.markTab(r.view); }, function (e) {
        self.el.innerHTML = '<div class="err">界面加载失败：' + self.esc(e && e.message || e) + '</div>';
      });
    },

    markTab: function (view) {
      var tabFor = { shelf: 'write', book: 'write', chapter: 'write', editor: 'write', section: 'write', me: 'me' };
      var cur = tabFor[view] || 'write';
      [].forEach.call(root.document.querySelectorAll('[data-tab]'), function (t) {
        t.classList.toggle('active', t.getAttribute('data-tab') === cur);
      });
    },

    esc: function (s) { return root.NOVEL_UTIL.escapeHtml(s); },

    /* ---------- 外观（界面设置：主题/字号/行距/首行缩进/内容宽度） ---------- */
    // 只改 :root 的 CSS 变量与 data-theme，不重写规则；paper 为主题默认值（无 data-theme 规则即纸色）。
    applyAppearance: function (a) {
      if (!a || !root.document) return;
      var de = root.document.documentElement, st = de.style;
      de.setAttribute('data-theme', a.theme === 'paper' ? '' : (a.theme || 'paper'));
      if (a.theme === 'paper') de.removeAttribute('data-theme');
      if (a.font_size) st.setProperty('--font-size', a.font_size + 'px');
      if (a.line_height) st.setProperty('--line-height', String(a.line_height));
      if (a.content_width) st.setProperty('--content-width', a.content_width + 'px');
      if (root.document.body) root.document.body.classList.toggle('indent', !!a.para_indent);
    },

    /* ---------- 系统返回键（原生 onBackPressed 转发至此） ---------- */
    // 统一回退入口 navigateUp()：系统返回键与界面返回按钮共用同一实现，行为严格一致。
    // 顺序：①有覆盖层（sheet 弹层 / FAB 菜单 / 预览区）先关覆盖层；②按当前 hash 逐级回退
    //   （节→章、编辑→章列表、章→书章节列表、书→书架）；③已在顶层页签（书架/我的根态）
    //   才走“再按一次退出”（2.5s 内连按两次真退）。回退成功不记 _lastBack、不弹退出提示。
    closeOverlay: function () {
      var el = this.el;
      if (!el || !el.querySelectorAll) return false;
      var closed = false;
      // 多个 .sheet（formSheet/confirmSheet/exSheet/编辑器自带）逐个检查 hidden
      [].forEach.call(el.querySelectorAll('.sheet'), function (s) { if (!s.hidden) { s.hidden = true; closed = true; } });
      if (closed) return true;
      var fw = el.querySelector('.fab-wrap.open');
      if (fw) {
        fw.classList.remove('open');
        var ap = fw.querySelector('.ai-pop.open');
        if (ap) ap.classList.remove('open');
        return true;
      }
      var pv = el.querySelector('.preview');
      if (pv && !pv.hidden) { pv.hidden = true; return true; }
      return false;
    },

    // 上一级路由：hint 为界面返回按钮声明的精确目标（优先用，避免反查）；
    // 无 hint 时从当前 hash 推导。章→书章节列表不拼空 bookId：state.bookId 取不到直接兜底回书架，
    // 绝不生成 #/book//chapters 这种非法路由。返回 false 表示已在顶层、无处可退。
    navigateUp: function (hint) {
      if (hint) { this.go(hint); return true; }
      var h = root.location.hash || '#/shelf', m;
      if ((m = h.match(/^#\/section\/(\d+)\/\d+$/))) { this.go('#/chapter/' + m[1]); return true; }
      if ((m = h.match(/^#\/editor\/\d+\/(\d+)$/))) { this.go('#/chapter/' + m[1]); return true; }
      if ((m = h.match(/^#\/chapter\/(\d+)$/))) {
        this.go(this.state.bookId ? '#/book/' + this.state.bookId + '/chapters' : '#/shelf');
        return true;
      }
      if (/^#\/book\/\d+/.test(h)) { this.go('#/shelf'); return true; }
      return false;   // #/shelf / #/me(/tab) 属顶层页签，无上级可退
    },

    onBack: function () {
      if (this.state.flush) { try { this.state.flush(); } catch (e) {} this.state.flush = null; }
      if (this.closeOverlay()) return;                        // 编辑态开着弹层/FAB/预览：本按返回只关覆盖层
      if (this.navigateUp()) { this._lastBack = 0; return; }  // 逐级回退成功：清双击计时，绝不弹退出提示
      var t = Date.now();
      if (this._lastBack && (t - this._lastBack) < 2500) { this.nativeExit(); return; }
      this._lastBack = t;
      this.toast('再按一次返回键退出应用');
    },

    nativeExit: function () {
      var AB = root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.AppBack;
      if (AB && AB.exitApp) { AB.exitApp(); return; }
      // 无原生插件（浏览器预览）降级：尽量关闭
      try { root.history.length > 1 && root.history.back(); } catch (e) {}
    },

    /* ---------- 回收站到点真删（生命周期） ----------
       仅当存储设置 temp_auto_clean 为真才执行 purgeExpired(temp_keep_days||7)；
       60s 内节流防抖（启动/回前台多次触发只跑一次）。失败不抛异常，静默降级。 */
    _purgeAt: 0,
    runPurge: function () {
      var t = Date.now();
      if (this._purgeAt && (t - this._purgeAt) < 60000) return Promise.resolve(0);
      this._purgeAt = t;
      return DB.getSetting('storage').then(function (stg) {
        if (!stg || !stg.temp_auto_clean) return 0;   // 未开启自动清理：什么都不做
        return DB.purgeExpired(stg.temp_keep_days || 7);
      }).catch(function (e) { console.log('[app] purge 失败', e); return 0; });
    },

    toast: function (msg, kind) {
      var t = document.getElementById('toast');
      if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
      t.textContent = msg; t.className = 'toast show ' + (kind || '');
      var self = this;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(function () { t.className = 'toast'; }, 2200);
    },

    /* ---------- 启动 ---------- */
    start: function () {
      var self = this;
      this.el = document.getElementById('screen');
      root.addEventListener('hashchange', function () { self.render(); });

      // 系统返回键：原生 onBackPressed 会直接调 NOVEL_APP.onBack()（见 AppBack 插件）；
      // 若装了 @capacitor/app（本工程未装）则同样转发到 onBack，保证两套机制行为一致。
      var A = root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.App;
      if (A && A.addListener) {
        A.addListener('backButton', function () { self.onBack(); });
      }

      // 切后台不丢稿（F54）：页面隐藏 / 原生 pause / appStateChange(active=false) 都强制落盘当前编辑
      function flushDraft() {
        if (!self.state.flush) return;
        try { var r = self.state.flush(); if (r && r.catch) r.catch(function () {}); } catch (e) { /* 落盘失败已在守卫内保脏重试 */ }
      }
      if (root.document && root.document.addEventListener) {
        root.document.addEventListener('visibilitychange', function () {
          if (root.document.hidden) flushDraft();
          else self.runPurge();   // 回到可见：触发一次到点真删（60s 节流）
        });
      }
      if (A && A.addListener) {
        A.addListener('pause', flushDraft);
        A.addListener('appStateChange', function (s) {
          if (s && s.isActive === false) flushDraft();
          else if (s && s.isActive === true) self.runPurge();   // 回前台：触发一次到点真删
        });
      }

      root.NOVEL_BOOT.boot().then(function (rep) {
        self.state.report = rep; self.state.booted = true;
        if (!rep.ready) {
          // 浏览器预览无 SQLite：给出明确提示，不白屏
          self.el.innerHTML = '<div class="wrap"><h1 class="ttl">AI 写作助手</h1><div class="err">数据层未就绪（'
            + self.esc(rep.error || '浏览器预览无 SQLite') + '）。请在原生 APK 内使用；逻辑层可在电脑跑 tests/。</div></div>';
          return;
        }
        // 数据层就绪后先应用外观（主题/字号/行距），再首屏渲染，避免闪一下默认样式
        return DB.getSetting('appearance').then(function (a) { self.applyAppearance(a); }, function () {});
      }).then(function () {
        if (!self.state.report || !self.state.report.ready) return;   // 数据层未就绪时不渲染（上面已提示）
        if (!root.location.hash) root.location.hash = '#/shelf';
        self.runPurge();   // 首屏渲染前触发一次到点真删（fire-and-forget，不阻塞渲染）
        self.render();
      });
    }
  };

  root.NOVEL_APP = App;
  // 统一入口：DOMContentLoaded 后 start
  document.addEventListener('DOMContentLoaded', function () { App.start(); });
})(globalThis);
