/* 加密存储层：API Key 等敏感信息只在本地以 AES-GCM 密文形态落盘，明文绝不进 SQLite / 备份 / 日志。
   设计要点（与 db.js 同构：适配器注入，App 用原生桥、Node 测试用 Web Crypto）：
   - 加解密走 globalThis.crypto.subtle（Capacitor WebView 150 与 Node 22 均有，同一份代码两端复用）
   - 密钥来自 keyProvider：原生优先走 Android Keystore 包裹的 SecureStore 插件；无插件时用设备内随机密钥兜底（较弱，见 caveats）
   - 密文经 storage 适配器持久化（App 端走 Preferences，测试端走内存 Map），只存信封 {v,alg,iv,ct}
   - AAD 绑定条目名，防止把 A 项密文改名冒充 B 项；GCM 标签自带完整性校验，篡改即解密失败
   铁律：本模块永不把明文写进 SQLite；备份与日志只允许出现密文或经 redact() 脱敏后的文本。 */
(function (root) {
  'use strict';

  var subtle = null;          // SubtleCrypto 实例，init 时从适配器或 globalThis.crypto.subtle 取
  var rng = null;             // getRandomValues，随 subtle 一起解析
  var keyProvider = null;     // { getKey(): Promise<CryptoKey> }
  var storage = null;         // { getItem, setItem, removeItem, keys }
  var ready = false;
  var lastError = '';

  var SECRET_PREFIX = 'sec:';   // storage 里密文信封的命名空间前缀
  var AAD_PREFIX = 'novel-secure:';
  var IV_LEN = 12;              // AES-GCM 推荐 96-bit IV
  var MASK = '\u2022\u2022\u2022\u2022'; // ••••

  /* ---------- 编解码工具（Node 与浏览器通用） ---------- */

  function utf8(str) { return new TextEncoder().encode(String(str)); }
  function fromUtf8(buf) { return new TextDecoder().decode(buf); }
  function b64enc(bytes) {
    var bin = '';
    var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (var i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
    return btoa(bin);
  }
  function b64dec(str) {
    var bin = atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function storageKey(name) { return SECRET_PREFIX + name; }
  function nameOf(storageKeyStr) { return storageKeyStr.slice(SECRET_PREFIX.length); }

  function validateName(name) {
    if (typeof name !== 'string' || !name.length) throw new Error('条目名非法: ' + name);
    if (/[\s]/.test(name)) throw new Error('条目名不能含空白: ' + name);
    if (name.indexOf(SECRET_PREFIX) === 0) throw new Error('条目名不能以保留前缀开头: ' + name);
  }

  function requireReady() {
    if (!ready) throw new Error('加密存储未就绪：' + (lastError || '请先调用 NOVEL_SECURE.init()'));
  }

  function getKey() {
    return Promise.resolve(keyProvider.getKey()).then(function (k) {
      if (!k) throw new Error('密钥提供器未返回 CryptoKey');
      return k;
    });
  }

  /* ---------- 生命周期 ---------- */

  // adapter = { keyProvider:{getKey}, storage:{getItem,setItem,removeItem,keys}, subtle?, crypto? }
  function init(adapter) {
    ready = false; lastError = '';
    if (!adapter || !adapter.keyProvider || !adapter.storage) {
      lastError = 'init 需要 { keyProvider, storage }';
      return Promise.reject(new Error(lastError));
    }
    var c = adapter.crypto || root.crypto;
    subtle = adapter.subtle || (c && c.subtle) || null;
    rng = c && typeof c.getRandomValues === 'function'
      ? function (arr) { return c.getRandomValues(arr); }
      : null;
    if (!subtle) { lastError = '当前环境缺少 Web Crypto（crypto.subtle）'; return Promise.reject(new Error(lastError)); }
    if (!rng) { lastError = '当前环境缺少 crypto.getRandomValues'; return Promise.reject(new Error(lastError)); }
    keyProvider = adapter.keyProvider;
    storage = adapter.storage;
    ready = true;
    return Promise.resolve({ ready: true });
  }

  function isReady() { return ready; }
  function state() { return { ready: ready, error: lastError }; }

  /* ---------- 核心读写 ---------- */

  // 明文入库：随机 IV + AAD(条目名) 加密，落盘只存信封 JSON
  function setSecret(name, plaintext) {
    requireReady();
    validateName(name);
    if (plaintext === undefined || plaintext === null) throw new Error('不能写入 undefined/null 明文');
    var iv = rng(new Uint8Array(IV_LEN));
    return getKey().then(function (key) {
      return subtle.encrypt(
        { name: 'AES-GCM', iv: iv, additionalData: utf8(AAD_PREFIX + name), tagLength: 128 },
        key, utf8(plaintext)
      );
    }).then(function (ctBuf) {
      var env = { v: 1, alg: 'AES-GCM', iv: b64enc(iv), ct: b64enc(new Uint8Array(ctBuf)) };
      return storage.setItem(storageKey(name), JSON.stringify(env));
    }).then(function () { return true; });
  }

  function hasSecret(name) {
    requireReady();
    return Promise.resolve(storage.getItem(storageKey(name))).then(function (raw) { return !!raw; });
  }

  // 解密取明文；密钥变更/被篡改会抛可读错误（GCM 认证失败）
  function getSecret(name) {
    requireReady();
    return Promise.resolve(storage.getItem(storageKey(name))).then(function (raw) {
      if (!raw) return null;
      var env;
      try { env = JSON.parse(raw); }
      catch (e) { throw new Error('密文信封损坏: ' + name); }
      if (!env || env.alg !== 'AES-GCM' || !env.iv || !env.ct) throw new Error('密文信封格式不受支持: ' + name);
      return getKey().then(function (key) {
        return subtle.decrypt(
          { name: 'AES-GCM', iv: b64dec(env.iv), additionalData: utf8(AAD_PREFIX + name), tagLength: 128 },
          key, b64dec(env.ct)
        ).catch(function () { throw new Error('解密失败（密钥变更或数据被篡改）: ' + name); });
      }).then(function (ptBuf) { return fromUtf8(ptBuf); });
    });
  }

  function removeSecret(name) {
    requireReady();
    return Promise.resolve(storage.removeItem(storageKey(name))).then(function () { return true; });
  }

  // 只列出条目名，永不返回明文/密文值——供配置页展示"已配置哪些密钥"
  function listSecrets() {
    requireReady();
    return Promise.resolve(storage.keys()).then(function (allKeys) {
      return (allKeys || []).filter(function (k) { return k.indexOf(SECRET_PREFIX) === 0; })
        .map(nameOf).sort();
    });
  }

  // 掩码回显：仅在需要时解密，只暴露尾 4 位，其余打码；不落任何中间明文缓存
  function getMasked(name, opts) {
    requireReady();
    var keepTail = (opts && typeof opts.tail === 'number') ? opts.tail : 4;
    return getSecret(name).then(function (plain) {
      if (plain === null) return null;
      var s = String(plain);
      if (s.length <= keepTail) return MASK;
      return MASK + s.slice(s.length - keepTail);
    });
  }

  /* ---------- 日志/导出脱敏（F55）---------- */

  // 把 text 中出现过的任何已存密钥明文替换成 [已脱敏]；用于崩溃日志、请求失败落盘、导出物净化
  function redact(text) {
    requireReady();
    var src = String(text == null ? '' : text);
    return listSecrets().then(function (names) {
      var chain = Promise.resolve(src);
      names.forEach(function (name) {
        chain = chain.then(function (acc) {
          return getSecret(name).then(function (plain) {
            if (!plain || plain.length < 4) return acc;   // 太短的密钥不误伤正文
            return acc.split(plain).join('[\u5df2\u8131\u654f]');
          }).catch(function () { return acc; });          // 单条解密失败不影响整体
        });
      });
      return chain;
    });
  }

  /* ---------- 密钥提供器工厂（App 与测试都用它构造 keyProvider） ---------- */

  // 从原始字节导入 AES-GCM 密钥：Node 测试、或原生插件解包 Keystore 后回传字节时用
  function keyProviderFromRawBytes(getBytes) {
    // getBytes(): Promise<Uint8Array|number[]> —— 返回 32 字节 AES-256 主密钥
    var cached = null;
    return {
      getKey: function () {
        if (cached) return cached;
        return Promise.resolve(getBytes()).then(function (b) {
          var u = b instanceof Uint8Array ? b : new Uint8Array(b);
          if (u.length !== 32) throw new Error('AES-256 主密钥需 32 字节，实得 ' + u.length);
          return subtle.importKey('raw', u, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        }).then(function (k) { cached = k; return k; });
      }
    };
  }

  // 原生 SecureStore（Android Keystore 包裹）契约：插件 getKey() 直接返回可导入的密钥字节
  // 约定 Kotlin 插件形态：window.Capacitor.Plugins.SecureStore.getKey() -> { value: base64(32字节) }
  function keyProviderFromNative(plugin) {
    var cached = null;
    return {
      getKey: function () {
        if (cached) return cached;
        if (!plugin || typeof plugin.getKey !== 'function') throw new Error('SecureStore 原生插件缺失');
        return Promise.resolve(plugin.getKey()).then(function (r) {
          var b64 = r && (r.value || r.key);
          if (!b64) throw new Error('SecureStore.getKey 未返回密钥');
          return keyProviderFromRawBytes(function () { return b64dec(b64); }).getKey();
        }).then(function (k) { cached = k; return k; });
      }
    };
  }

  // 设备内随机密钥兜底：首次生成随机 32 字节、以 base64 存进 storage（前缀 dk:），之后复用。
  // 说明：未经 Keystore 包裹，安全性弱于原生路径，仅用于浏览器预览 / M3 原生插件落地前的过渡。
  function keyProviderFromLocalSecret(storage0) {
    var cached = null;
    var DEV_KEY = 'dk:master';
    return {
      getKey: function () {
        if (cached) return cached;
        return Promise.resolve(storage0.getItem(DEV_KEY)).then(function (raw) {
          if (raw) return b64dec(raw);
          var b = rng(new Uint8Array(32));
          return Promise.resolve(storage0.setItem(DEV_KEY, b64enc(b))).then(function () { return b; });
        }).then(function (bytes) {
          return subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        }).then(function (k) { cached = k; return k; });
      }
    };
  }

  /* ---------- storage 适配器工厂 ---------- */

  // @capacitor/preferences 桥：Values 型命名空间，keys() 返回本命名空间下所有键
  function makePrefsStorage(Preferences, ns) {
    var prefs = Preferences;
    if (!prefs) throw new Error('Preferences 插件未注册');
    var bag = ns ? prefs.configure({ group: ns }) : prefs;
    return {
      getItem: function (k) { return Promise.resolve(bag.get({ key: k })).then(function (r) { return r ? r.value : null; }); },
      setItem: function (k, v) { return Promise.resolve(bag.set({ key: k, value: String(v) })); },
      removeItem: function (k) { return Promise.resolve(bag.remove({ key: k })); },
      keys: function () { return Promise.resolve(bag.keys()).then(function (r) { return (r && r.keys) || []; }); }
    };
  }

  // 纯内存 storage：Node 测试与浏览器预览降级用；进程退出即散，仅作验证不构成持久存储
  function makeMemoryStorage(seed) {
    var m = new Map();
    Object.keys(seed || {}).forEach(function (k) { m.set(k, String(seed[k])); });
    return {
      getItem: function (k) { return Promise.resolve(m.has(k) ? m.get(k) : null); },
      setItem: function (k, v) { m.set(k, String(v)); return Promise.resolve(); },
      removeItem: function (k) { m.delete(k); return Promise.resolve(); },
      keys: function () { return Promise.resolve(Array.from(m.keys())); }
    };
  }

  root.NOVEL_SECURE = {
    init: init, isReady: isReady, state: state,
    setSecret: setSecret, getSecret: getSecret, getMasked: getMasked,
    hasSecret: hasSecret, removeSecret: removeSecret, listSecrets: listSecrets,
    redact: redact,
    keyProviderFromRawBytes: keyProviderFromRawBytes,
    keyProviderFromNative: keyProviderFromNative,
    keyProviderFromLocalSecret: keyProviderFromLocalSecret,
    makePrefsStorage: makePrefsStorage,
    makeMemoryStorage: makeMemoryStorage,
    _internal: { b64enc: b64enc, b64dec: b64dec, SECRET_PREFIX: SECRET_PREFIX }
  };
})(globalThis);
