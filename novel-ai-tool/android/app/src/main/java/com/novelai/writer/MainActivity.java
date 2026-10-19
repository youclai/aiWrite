package com.novelai.writer;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

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

        // 建议2：系统返回键交给 JS 决策（App.onBack）——逐级回退，到顶层二次确认再调 AppBack.exitApp 退出。
        // targetSdk>=35 起预测式返回默认开启，旧版 onBackPressed() 覆写不再被系统可靠调用；
        // 改用 AndroidX OnBackPressedDispatcher：实体返回键 / 侧滑手势 / legacy 路径都统一进本回调。
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                Bridge b = getBridge();
                final WebView wv = (b != null) ? b.getWebView() : null;
                if (wv == null) {
                    // WebView 未就绪：临时禁用本回调，交回系统默认返回（退出），避免返回键彻底失灵
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    return;
                }
                // evaluateJavascript 必须在 UI 线程；WebView 非当前线程时 post 过去
                wv.post(new Runnable() {
                    @Override
                    public void run() {
                        wv.evaluateJavascript("window.NOVEL_APP && NOVEL_APP.onBack && NOVEL_APP.onBack();", null);
                    }
                });
            }
        });
    }
}
