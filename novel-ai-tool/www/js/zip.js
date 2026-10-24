/* 极简 ZIP 读写：零第三方依赖，纯 Uint8Array 计算，Node/浏览器同源可跑。
   导出：STORE 不压缩（产物字节稳定可测）；读取：STORE 直取 + DEFLATE(method=8) 可解压——
   外部 Word/WPS 导出的 docx 成员是 DEFLATE 压缩，需要同源解压能力（优化批次 A）。
   - build(entries) → Uint8Array                     entries: [{name, data(string|Uint8Array)}]
   - list(bytes)    → [{name, data, method, text()}] 同步读；DEFLATE 成员 data 为压缩字节，text() 报错提醒走异步
   - listAsync(bytes[, {inflate}]) → Promise<同上>    method=8 成员逐条 inflate-raw 后返回明文
   inflate 默认用 DecompressionStream('deflate-raw')（Chromium 80+/Node 18+）；测试可注入自定义 inflate。
   文件名一律按 UTF-8 编码并置 general purpose bit 11，保证中文名跨端不乱。 */
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  var enc = new TextEncoder();
  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return enc.encode(data);
    if (data && data.length != null) return new Uint8Array(data);   // ArrayBuffer / Array
    return new Uint8Array(0);
  }

  // 小端写入助手
  function w16(view, off, v) { view.setUint16(off, v & 0xFFFF, true); }
  function w32(view, off, v) { view.setUint32(off, v >>> 0, true); }

  // 时间戳固定 1980-01-01 00:00（避免时区抖动，产物字节稳定可测）
  var DOS_TIME = 0, DOS_DATE = 0x21;   // date 最低位域：年 = 1980 → (0)<<9 | 1<<5 | 1 = 0x21

  function build(entries) {
    entries = entries || [];
    var locals = [], central = [], offset = 0;

    entries.forEach(function (e) {
      var nameBytes = enc.encode(e.name);
      var data = toBytes(e.data);
      var crc = crc32(data);

      var lh = new Uint8Array(30 + nameBytes.length + data.length);
      var lv = new DataView(lh.buffer);
      w32(lv, 0, 0x04034b50);       // 本地文件头签名
      w16(lv, 4, 20);               // version needed
      w16(lv, 6, 0x0800);           // flags：UTF-8 文件名
      w16(lv, 8, 0);                // method：store
      w16(lv, 10, DOS_TIME); w16(lv, 12, DOS_DATE);
      w32(lv, 14, crc);
      w32(lv, 18, data.length);     // comp size
      w32(lv, 22, data.length);     // uncomp size
      w16(lv, 26, nameBytes.length);
      w16(lv, 28, 0);               // extra len
      lh.set(nameBytes, 30);
      lh.set(data, 30 + nameBytes.length);
      locals.push(lh);

      var ch = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(ch.buffer);
      w32(cv, 0, 0x02014b50);       // 中央目录头签名
      w16(cv, 4, 20); w16(cv, 6, 20);
      w16(cv, 8, 0x0800);
      w16(cv, 10, 0);               // method store
      w16(cv, 12, DOS_TIME); w16(cv, 14, DOS_DATE);
      w32(cv, 16, crc);
      w32(cv, 20, data.length); w32(cv, 24, data.length);
      w16(cv, 28, nameBytes.length);
      w16(cv, 30, 0);               // extra
      w16(cv, 32, 0);               // comment
      w16(cv, 34, 0);               // disk start
      w16(cv, 36, 0);               // internal attrs
      w32(cv, 38, 0);               // external attrs
      w32(cv, 42, offset);          // 本地头相对偏移
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length;
    });

    var centralSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    w32(ev, 0, 0x06054b50);
    w16(ev, 8, entries.length); w16(ev, 10, entries.length);
    w32(ev, 12, centralSize);
    w32(ev, 16, offset);           // 中央目录起始 = 所有本地头长度之和
    w16(ev, 20, 0);

    var out = new Uint8Array(offset + centralSize + 22);
    var p = 0;
    locals.forEach(function (b) { out.set(b, p); p += b.length; });
    central.forEach(function (b) { out.set(b, p); p += b.length; });
    out.set(eocd, p);
    return out;
  }

  // 读回：从 EOCD 定位中央目录，逐条解析名字/方法/尺寸（均以中央目录为准，本地头尺寸在流式写入时可能为 0），
  // 再回本地头取数据偏移。method=8（DEFLATE）成员的 data 是压缩字节，text() 直接报错引导走 listAsync。
  function list(bytes) {
    var buf = toBytes(bytes);
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // 反向找 EOCD 签名
    var eocd = -1;
    for (var i = buf.length - 22; i >= 0 && i > buf.length - 22 - 66000; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP（找不到 EOCD）');
    var count = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    var res = [], ptr = cdOff;
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(ptr, true) !== 0x02014b50) throw new Error('中央目录签名异常 @' + ptr);
      var method = dv.getUint16(ptr + 10, true);
      var compSize = dv.getUint32(ptr + 20, true);
      var uncompSize = dv.getUint32(ptr + 24, true);
      var nameLen = dv.getUint16(ptr + 28, true);
      var extraLen = dv.getUint16(ptr + 30, true);
      var cmtLen = dv.getUint16(ptr + 32, true);
      var lho = dv.getUint32(ptr + 42, true);
      var name = new TextDecoder().decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));
      // 数据起点仍由本地头的花名/附加字段长度决定（中央目录不含本地头 extra 布局）
      var lNameLen = dv.getUint16(lho + 26, true);
      var lExtraLen = dv.getUint16(lho + 28, true);
      var size = method === 8 ? compSize : uncompSize;
      var dataStart = lho + 30 + lNameLen + lExtraLen;
      var data = buf.slice(dataStart, dataStart + size);
      var entry = { name: name, data: data, method: method };
      if (method === 0) {
        entry.text = (function (dd) { return function () { return new TextDecoder().decode(dd); }; })(data);
      } else if (method === 8) {
        entry.text = function () { throw new Error('ZIP 成员是 DEFLATE 压缩，请用 listAsync/inflate 解压后再读'); };
      } else {
        throw new Error('不支持的 ZIP 压缩方法: ' + method + '（仅支持 store 与 deflate）');
      }
      res.push(entry);
      ptr += 46 + nameLen + extraLen + cmtLen;
    }
    return res;
  }

  // inflate-raw 默认实现：DecompressionStream('deflate-raw')（Chromium 80+ / Node 18+ 都有）；
  // 环境缺失时 reject 带 code='need-inflate'，调用方负责降级提示（勿静默产乱码）。
  function inflateRaw(u8) {
    try {
      if (typeof root.DecompressionStream !== 'function' || typeof root.Blob !== 'function') throw new Error('no api');
      var ds = new root.DecompressionStream('deflate-raw');
      var stream = new root.Blob([u8]).stream().pipeThrough(ds);
      var ab = typeof root.Response === 'function' ? new root.Response(stream).arrayBuffer() : streamToBuffer(stream);
      return Promise.resolve(ab).then(function (b) { return new Uint8Array(b); });
    } catch (e) {
      var err = new Error('运行环境缺少 inflate 能力，无法读取压缩的 Word 文件');
      err.code = 'need-inflate';
      return Promise.reject(err);
    }
  }
  // 无 Response 环境（理论上走不到）：手动排空可读流
  function streamToBuffer(stream) {
    var reader = stream.getReader(), chunks = [];
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          var len = chunks.reduce(function (s, c) { return s + c.length; }, 0), out = new Uint8Array(len), p = 0;
          chunks.forEach(function (c) { out.set(c, p); p += c.length; });
          return out.buffer;
        }
        chunks.push(r.value); return pump();
      });
    }
    return pump();
  }

  // 异步读回：同步 list + 对 method=8 成员逐条 inflate；opts.inflate 可注入（Node 测试用 zlib）。
  function listAsync(bytes, opts) {
    var inflate = (opts && opts.inflate) || inflateRaw;
    var entries;
    try { entries = list(bytes); } catch (e) { return Promise.reject(e); }
    return Promise.all(entries.map(function (e) {
      if (e.method !== 8) return e;
      return Promise.resolve(inflate(e.data)).then(function (u8) {
        return { name: e.name, data: u8, method: 0,
          text: (function (dd) { return function () { return new TextDecoder().decode(dd); }; })(u8) };
      }, function (err) {
        if (err && err.code === 'need-inflate') throw err;
        var e2 = new Error('解压 ZIP 成员失败（' + e.name + '）：' + ((err && err.message) || err));
        e2.code = 'inflate-failed';
        throw e2;
      });
    }));
  }

  root.NOVEL_ZIP = { build: build, list: list, listAsync: listAsync, inflateRaw: inflateRaw, crc32: crc32 };
})(globalThis);
