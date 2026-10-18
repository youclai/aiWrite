/* 流式请求抽象（F06 接 AiStream）：把"发请求→逐段收 delta→可取消"收敛成一个 run()，
   传输层可注入：mock（本地假 SSE，走与真实相同的 parseLine 路径，Node 可端到端测）
   / 原生（包 window.Capacitor.Plugins.AiStream，未真机验）。
   密钥只在运行时以明文注入请求头，本模块不缓存、不落盘。 */
(function (root) {
  'use strict';

  function splitChunks(text, size) {
    var arr = Array.from(String(text || ''));
    var out = [], n = size || 6;
    for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n).join(''));
    return out;
  }

  // 把一段完整文本伪装成 openai SSE 逐行吐，供 mock/测试复用真实解析路径
  function makeMockSseTransport(desc, chunkSize) {
    return {
      request: function (req, h) {
        var cancelled = false;
        var reply = desc.mockReply ? desc.mockReply(req.prompt) : String(req.prompt || '');
        var chunks = splitChunks(reply, chunkSize);
        var i = 0;
        function step() {
          if (cancelled) { return; }
          if (i < chunks.length) {
            h.onLine('data: ' + JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] }));
            i++;
            setTimeout(step, 0);
          } else {
            h.onLine('data: [DONE]');
          }
        }
        setTimeout(step, 0);   // 异步起步：确保 run() 已返回 handle、onDelta 里 cancel 不会踩 TDZ
        return { cancel: function () { cancelled = true; } };
      }
    };
  }

  // 包原生 AiStream 插件：契约见 M3-a；插件回传原始 SSE 行 / error / done
  function nativeTransport(Plugin) {
    return {
      request: function (req, h) {
        if (!Plugin || typeof Plugin.start !== 'function') { h.onError(new Error('AiStream 原生插件未注册')); return { cancel: function () {} }; }
        var rid = 'r' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
        var off = Plugin.addListener ? Plugin.addListener('aiStream:' + rid, function (ev) {
          if (ev.line != null) h.onLine(ev.line);
          else if (ev.done) h.onLine('data: [DONE]');
          else if (ev.error) h.onError(new Error(ev.error));
        }) : null;
        var handle = {
          cancel: function () {
            try { Plugin.cancel && Plugin.cancel({ requestId: rid }); } catch (e) {}
            try { if (off && off.remove) off.remove(); else off && off(); } catch (e) {}
          }
        };
        Plugin.start(Object.assign({ requestId: rid, method: req.method, url: req.url, headers: req.headers, body: req.body }));
        return handle;
      }
    };
  }

  // opts = {desc, prompt, key, system, transport, onDelta(text,full), onDone(full), onError(reason,full)}
  function run(opts) {
    opts = opts || {};
    var desc = opts.desc;
    if (!desc) throw new Error('run 需要 desc（NOVEL_PROVIDERS.describe 的产物）');
    var req = desc.buildRequest(opts.prompt || '', { key: opts.key || '', system: opts.system });
    var transport = opts.transport
      || (desc.style === 'mock' ? makeMockSseTransport(desc) : null)
      || (root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.AiStream ? nativeTransport(root.Capacitor.Plugins.AiStream) : null);
    if (!transport) throw new Error('无可用传输层（非原生且非 mock）');

    var full = '', finished = false;
    function finish() {
      if (finished) return; finished = true;
      if (opts.onDone) opts.onDone(full);
    }
    var handle = transport.request(req, {
      onLine: function (line) {
        var ev = desc.parseLine(line);
        if (ev.kind === 'delta') { full += ev.text; if (opts.onDelta) opts.onDelta(ev.text, full); }
        else if (ev.kind === 'done') { finish(); }
      },
      onError: function (err) {
        if (finished) return; finished = true;
        if (opts.onError) opts.onError(desc.errorReason(err), full);
      }
    });
    return {
      cancel: function () { handle.cancel(); },
      text: function () { return full; }
    };
  }

  root.NOVEL_STREAM = {
    run: run,
    makeMockSseTransport: makeMockSseTransport,
    nativeTransport: nativeTransport,
    splitChunks: splitChunks
  };
})(globalThis);
