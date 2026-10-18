package com.novelai.writer;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 返回键接管（M7）：JS 侧 window.Capacitor.Plugins.AppBack。
 * 工程未安装 @capacitor/app，故自研一个最小插件专供“双击返回退出应用”时使用：
 *   exitApp() -> 结束当前 Activity（MainActivity.onBackPressed 已把系统返回键转交 JS 决策，
 *                 JS 逐级回退到书架后、二次确认要退出时调用本方法真正关闭应用）。
 * 纯 Java（App 模块未启用 Kotlin）。
 */
@CapacitorPlugin(name = "AppBack")
public class AppBackPlugin extends Plugin {

    @PluginMethod
    public void exitApp(PluginCall call) {
        getActivity().finish();
    }
}
