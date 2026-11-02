/* 版本更新检查配置（G1，单点维护）：网盘链接与仓库信息只在本文件登记，
   发布新版本换网盘时改这里即可；Gitee Release 元信息（版本/更新日志/附件）由 API 自动拉取，不在此配置。
   隐私口径：仅向 gitee.com 发只读 GET 查询版本，不携带任何设备/作品信息（详见「用户说明」）。 */
(function (root) {
  'use strict';

  root.UPDATE_CONFIG = {
    // Gitee 仓库（自动拉取最新 Release，接口：/api/v5/repos/{owner}/{repo}/releases/latest）
    gitee: { owner: 'wehello', repo: 'aiWriting' },
    // 百度网盘：链接 + 提取码（发布新版本时如有变化手动更新）
    baidu: {
      link: 'https://pan.baidu.com/s/1KZWBqXR2hTcw-Xz9sGQXXA?pwd=z8f4',
      extractCode: 'z8f4'
    },
    // 夸克网盘：分享链接 + 口令片段（复制整段便于用户在夸克 App 内识别）
    quark: {
      link: 'https://pan.quark.cn/s/2627cf4e97e9',
      shareText: '/~34453c0hXQ~:/'
    },
    // 冷却期：点「14天内不提醒」后 14 天内不再自动弹窗（手动检查不受限）
    snoozeDays: 14,
    // 网络超时：5 秒拿不到响应即放弃本轮检查，静默跳过不影响使用
    timeoutMs: 5000
  };
})(globalThis);
