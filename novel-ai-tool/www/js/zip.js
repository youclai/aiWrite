/* 极简 ZIP（STORE 不压缩）读写：零第三方依赖，纯 Uint8Array 计算，Node/浏览器同源可跑。
   够用即可——导出的都是文本类（txt/md/docx 的 XML），压缩收益小、且 STORE 让格式可控可测；
   真机要压缩可日后把 method 换成 deflate（Node 有 zlib、WebView 有 CompressionStream），接口不变。
   - build(entries) → Uint8Array   entries: [{name, data(string|Uint8Array)}]
   - list(bytes)    → [{name, data(Uint8Array), text()}]   读回（测试与自检用）
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

  // 读回：从 EOCD 定位中央目录，逐条解析名字，再回本地头取数据
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
      var nameLen = dv.getUint16(ptr + 28, true);
      var extraLen = dv.getUint16(ptr + 30, true);
      var cmtLen = dv.getUint16(ptr + 32, true);
      var lho = dv.getUint32(ptr + 42, true);
      var name = new TextDecoder().decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));
      // 解析本地头拿数据偏移与大小
      var lNameLen = dv.getUint16(lho + 26, true);
      var lExtraLen = dv.getUint16(lho + 28, true);
      var size = dv.getUint32(lho + 22, true);
      var dataStart = lho + 30 + lNameLen + lExtraLen;
      var data = buf.slice(dataStart, dataStart + size);
      res.push({ name: name, data: data, text: (function (dd) { return function () { return new TextDecoder().decode(dd); }; })(data) });
      ptr += 46 + nameLen + extraLen + cmtLen;
    }
    return res;
  }

  root.NOVEL_ZIP = { build: build, list: list, crc32: crc32 };
})(globalThis);
