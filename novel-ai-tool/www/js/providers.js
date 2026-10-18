/* provider 适配（F50/F51/F52）：把"用哪家服务"收敛成统一的 describe()，产出
   - buildRequest(prompt, {key, system}) → {method,url,headers,body}   （key 运行时注入，绝不明文存 settings）
   - parseLine(line) → {kind:'delta'|'done'|'status'|'ignore', text?, httpStatus?}   （SSE 行级解析）
   - errorReason(err) → 可判定失败原因（DNS/超时/401/403/非2xx）
   预设：openai_chat 通用格式为骨架，DeepSeek / 通义千问(Qwen, DashScope 兼容模式) 为其 host 预设；
   anthropic 走自有 messages 协议；custom 用户填 base_url；mock 不联网、本地回一段假 SSE 走通全流程。 */
(function (root) {
  'use strict';

  // models：该服务商已知常用模型 ID 清单，供界面下拉选择（避免用户凭记忆猜模型编号）；
  //          清单外的新模型/私有部署走界面“手动输入…”兜底。custom 无预设清单，一律手输。
  var PRESETS = {
    openai_chat: { style: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini'] },
    deepseek:    { style: 'openai', base: 'https://api.deepseek.com',   model: 'deepseek-flash',
      models: ['deepseek-flash', 'deepseek-v4-pro'] },
    qwen:        { style: 'openai', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
      models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
    custom:      { style: 'openai', base: '',                            model: '' },
    anthropic:   { style: 'anthropic', base: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest',
      models: ['claude-3-7-sonnet-latest', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'] },
    mock:        { style: 'mock', base: '', model: 'mock' }
  };

  function trimSlash(s) { return String(s || '').replace(/\/+$/, ''); }

  // cfg = {provider, base_url, model, temperature}；未填的按预设补
  function describe(cfg) {
    cfg = cfg || {};
    var p = cfg.provider || 'openai_chat';
    var preset = PRESETS[p] || PRESETS.openai_chat;
    var style = cfg.style || preset.style || 'openai';
    var base = trimSlash(cfg.base_url || preset.base);
    var model = cfg.model || preset.model || '';
    var temperature = cfg.temperature === undefined ? 0.7 : cfg.temperature;

    if (style === 'mock') return mockProvider(model);
    if (style !== 'anthropic' && !base) throw new Error('provider base_url 未配置: ' + p);

    return {
      provider: p, style: style, base: base, model: model,
      buildRequest: function (prompt, opts) {
        opts = opts || {};
        var key = opts.key || '';
        var system = opts.system || '你是一名专业的中文小说写作助手，只输出可入稿的正文，不要解释。';
        if (style === 'anthropic') {
          return {
            method: 'POST',
            url: base + '/messages',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': key,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: model, system: system, max_tokens: opts.max_tokens || 2048, stream: true,
              messages: [{ role: 'user', content: prompt }]
            })
          };
        }
        // openai 兼容（openai_chat / deepseek / qwen / custom）
        return {
          method: 'POST',
          url: base + '/chat/completions',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer ' + key
          },
          body: JSON.stringify({
            model: model, stream: true, temperature: temperature,
            messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
          })
        };
      },
      parseLine: parseLineFor(style),
      errorReason: errorReason
    };
  }

  function parseLineFor(style) {
    return style === 'anthropic' ? parseAnthropicLine : parseOpenAIBarLine;
  }

  // SSE 一行 → 事件。openai：data: {choices:[{delta:{content}}]} / data: [DONE]
  function parseOpenAIBarLine(line) {
    var s = String(line == null ? '' : line).trim();
    if (!s) return { kind: 'ignore' };
    if (s.charAt(0) !== 'd') return { kind: 'ignore' };        // 只吃 data:
    var payload = s.replace(/^data:\s?/, '');
    if (payload === '[DONE]') return { kind: 'done' };
    var obj;
    try { obj = JSON.parse(payload); } catch (e) { return { kind: 'ignore' }; }
    var ch = obj.choices && obj.choices[0];
    var text = (ch && ch.delta && ch.delta.content) || (ch && ch.text) || '';
    return text ? { kind: 'delta', text: text } : { kind: 'ignore' };
  }

  // anthropic：event: message_stop / data:{type content_block_delta, delta.text}
  function parseAnthropicLine(line) {
    var s = String(line == null ? '' : line).trim();
    if (!s) return { kind: 'ignore' };
    if (/^event:\s*message_stop/.test(s)) return { kind: 'done' };
    if (s.charAt(0) !== 'd') return { kind: 'ignore' };
    var payload = s.replace(/^data:\s?/, '');
    var obj;
    try { obj = JSON.parse(payload); } catch (e) { return { kind: 'ignore' }; }
    if (obj.type === 'content_block_delta' && obj.delta && obj.delta.text) return { kind: 'delta', text: obj.delta.text };
    if (obj.type === 'message_stop') return { kind: 'done' };
    return { kind: 'ignore' };
  }

  // 失败原因归一，供 F51/F06 界面给可读提示
  function errorReason(err) {
    var msg = String((err && (err.message || err)) || '');
    var low = msg.toLowerCase();
    if (/enotfound|eai_again|getaddrinfo|dns/.test(low)) return 'DNS 解析失败，检查网络或 base_url';
    if (/timeout|etimedout|timed out/.test(low)) return '连接超时，服务不可达或被墙';
    if (/econnrefused/.test(low)) return '连接被拒，base_url 或端口不对';
    var m = low.match(/(401|403|429|500|502|503)/);
    if (m) {
      var code = m[1];
      if (code === '401') return '鉴权失败(401)：API Key 无效或未配置';
      if (code === '403') return '被拒(403)：Key 无此权限或地域受限';
      if (code === '429') return '限流(429)：请求过快，稍后重试';
      return '服务端错误(' + code + ')：稍后重试';
    }
    if (/non-?2xx|http/.test(low)) return '非 2xx 响应：' + msg;
    return msg || '未知错误';
  }

  /* ---------- mock：不联网走通 F05→F10 ---------- */
  function mockProvider(model) {
    return {
      provider: 'mock', style: 'mock', base: '', model: model || 'mock',
      // mock 不需要真请求；返回一个标记对象，由 aistream/mock 直接吐假 SSE
      buildRequest: function (prompt) {
        return { method: 'MOCK', url: '', headers: {}, body: '', prompt: prompt, mock: true };
      },
      // 把 prompt 里"需要处理的内容"回一段假结果，并模拟真实模型的啰嗦包裹（引导语+外层引号），以便验证清洗闭环
      // 引导语取动作无关的"处理结果"（不再硬编码"润色"，避免误导），仅 Node 测试用；真机已由 apiReady 门禁拦截 mock
      mockReply: function (prompt) {
        var seg = String(prompt || '');
        var m = seg.match(/\[\u9700\u8981\u5904\u7406\u7684\u5185\u5bb9\]\n([\s\S]*?)(?:\n\[|$)/);
        var body = m ? m[1].trim() : seg.slice(-40);
        return '\u597d\u7684\uff0c\u4ee5\u4e0b\u662f\u5904\u7406\u7ed3\u679c\uff1a\n\n\u201c' + body + '\u201d\n';
      },
      parseLine: parseOpenAIBarLine,
      errorReason: errorReason
    };
  }

  root.NOVEL_PROVIDERS = {
    PRESETS: PRESETS,
    describe: describe,
    parseOpenAIBarLine: parseOpenAIBarLine,
    parseAnthropicLine: parseAnthropicLine,
    errorReason: errorReason
  };
})(globalThis);
