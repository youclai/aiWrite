package com.novelai.writer;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 应用级原生插件须在 super.onCreate()（内部 load() 构建 Bridge）之前登记
        registerPlugin(SecureStorePlugin.class);   // M3-b：Keystore 包裹主密钥（window.Capacitor.Plugins.SecureStore）
        registerPlugin(AiStreamPlugin.class);      // M3-a：SSE 流式传输（window.Capacitor.Plugins.AiStream）
        registerPlugin(AppBackPlugin.class);       // M7：返回键接管下 JS 退出应用（window.Capacitor.Plugins.AppBack.exitApp）
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onBackPressed() {
        // 系统返回键交给 JS 决策（App.onBack）：逐级回退，到书架后二次确认再调 AppBack.exitApp 真正退出。
        // WebView 非当前线程，post 到 UI 线程再 evaluateJavascript；bridge/WebView 未就绪则走默认返回。
        Bridge b = getBridge();
        final WebView wv = (b != null) ? b.getWebView() : null;
        if (wv != null) {
            wv.post(new Runnable() {
                @Override
                public void run() {
                    wv.evaluateJavascript("window.NOVEL_APP && NOVEL_APP.onBack && NOVEL_APP.onBack();", null);
                }
            });
        } else {
            super.onBackPressed();
        }
    }
}
