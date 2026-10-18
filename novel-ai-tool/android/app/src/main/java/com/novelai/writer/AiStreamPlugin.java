package com.novelai.writer;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * M3-a 原生流式传输插件（F06）：JS 侧 window.Capacitor.Plugins.AiStream。
 * 契约（与 www/js/aistream.js nativeTransport 严格对齐，勿改名）：
 *   start({ requestId, method, url, headers, body })  发起一次流式请求，不阻塞（RETURN_NONE，无 Promise）
 *   cancel({ requestId })                             断开在途连接
 *   逐行事件 notifyListeners("aiStream:" + requestId, { line })   —— line 为含 "data:" 前缀的原始 SSE 行，原样透传
 *   结束事件                 { done: true }
 *   错误事件                 { error: "<message>" }
 * 密钥只在请求头里透传，本插件不缓存、不落盘、不打印明文。
 * 说明：纯 Java 实现（App 模块未启用 Kotlin 插件），避免改动 gradle 构建；效果等价。
 */
@CapacitorPlugin(name = "AiStream")
public class AiStreamPlugin extends Plugin {

    private static final int CONNECT_TIMEOUT_MS = 20000;
    private static final int READ_TIMEOUT_MS = 120000;

    // requestId -> 在途连接；cancel() 据此断开，读到中断即停
    private final Map<String, HttpURLConnection> inflight = new ConcurrentHashMap<>();

    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void start(PluginCall call) {
        final String requestId = call.getString("requestId");
        if (requestId == null || requestId.isEmpty()) {
            call.reject("start 需要 requestId");
            return;
        }
        final String method = call.getString("method", "POST");
        final String url = call.getString("url");
        final String body = call.getString("body", "");
        final JSObject headers = call.getObject("headers");
        if (url == null || url.isEmpty()) {
            notifyError(requestId, "start 需要 url");
            return;
        }

        // 网络不能在主线程：自起后台线程逐行读流
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                runStream(requestId, method, url, headers, body);
            }
        }, "AiStream-" + requestId);
        t.setDaemon(true);
        t.start();
    }

    private void runStream(String requestId, String method, String url, JSObject headers, String body) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setDoInput(true);
            conn.setDoOutput(true);
            conn.setUseCaches(false);

            if (headers != null) {
                Iterator<String> it = headers.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    Object v = headers.opt(k);
                    conn.setRequestProperty(k, v == null ? "" : String.valueOf(v));
                }
            }

            inflight.put(requestId, conn);

            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            OutputStream os = conn.getOutputStream();
            os.write(payload);
            os.flush();
            os.close();

            int code = conn.getResponseCode();
            InputStream raw = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
            if (raw == null) {
                notifyError(requestId, "HTTP " + code + "（无响应体）");
                return;
            }

            if (code < 200 || code >= 300) {
                String errBody = drain(raw);
                notifyError(requestId, "HTTP " + code + (errBody.isEmpty() ? "" : "：" + errBody));
                return;
            }

            // 逐行透传原始 SSE 行（含 "data:" 前缀），空行跳过；JS 端 parseLine 解析
            BufferedReader reader = new BufferedReader(new InputStreamReader(raw, StandardCharsets.UTF_8));
            String line;
            while ((line = reader.readLine()) != null) {
                if (!inflight.containsKey(requestId)) {
                    return; // 已被 cancel
                }
                if (line.isEmpty()) {
                    continue;
                }
                JSObject ev = new JSObject();
                ev.put("line", line);
                notifyListeners("aiStream:" + requestId, ev);
            }
            notifyDone(requestId);
        } catch (java.io.IOException e) {
            // disconnect 会让阻塞的 readLine 抛 IOException —— 属正常取消，不再报错
            if (!inflight.containsKey(requestId)) {
                return;
            }
            notifyError(requestId, e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        } catch (Exception e) {
            notifyError(requestId, e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        } finally {
            inflight.remove(requestId);
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
    }

    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void cancel(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId == null) {
            return;
        }
        HttpURLConnection conn = inflight.remove(requestId);
        if (conn != null) {
            try { conn.disconnect(); } catch (Exception ignored) {}
        }
    }

    private void notifyDone(String requestId) {
        JSObject ev = new JSObject();
        ev.put("done", true);
        notifyListeners("aiStream:" + requestId, ev);
    }

    private void notifyError(String requestId, String message) {
        JSObject ev = new JSObject();
        ev.put("error", message == null ? "未知错误" : message);
        notifyListeners("aiStream:" + requestId, ev);
    }

    private static String drain(InputStream is) {
        try {
            BufferedReader r = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            int guard = 0;
            while ((line = r.readLine()) != null && guard++ < 64) {
                sb.append(line);
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }
}
