### 更新摘要

- OmniMail Float 升级到 `1.0.0`，与 Web/API `1.0.0` 建立稳定兼容基线。
- 八类官方来源、账号状态、能力字段和通知深链接进入 `1.x` 向后兼容承诺。
- 新增跨 Web/Float 契约回归；未来新增来源时，遗漏任一端的来源、路由或通知处理都会使
  CI 失败。

### 功能基线

- 保留 OmniMail、iCloud、Linux DO、Gmail、Microsoft、QQ、NAVER 与 Yandex 的现有
  地址、阅读、附件、搜索、同步、通知及按能力发信功能。
- 保留验证码本地识别与主动填入、亮暗主题、勿扰时段、键盘/读屏和窄面板支持。
- 完整来源与能力矩阵见 `extension/COMPATIBILITY.md`。

### 安全与升级

- Float `0.8.1` 可直接覆盖升级，现有登录、设置和来源选择继续保留。
- 本版本不新增 Chrome 权限、设备令牌 Scope、远程代码或数据处理类型，不需要重新授权。
- 仍只连接用户选择的 OmniMail 实例；第三方邮箱凭据继续只在 Web 端管理。

### 兼容性

- 需要 OmniMail Web/API `1.0.0` 或更高兼容版本，以及 Chrome 120 或更高版本。
- Chrome Web Store 固定扩展 ID 保持 `fpeecjailboemocpmpcbjaghpkpcaihf`。

### 发布验证

- 发布前运行类型检查、Oxlint、扩展单元测试、生产构建和真实 Chromium 全来源 smoke。
- 继续覆盖从旧商店会话升级、令牌轮换、来源故障隔离、通知与 375px 窄面板回归。

### 发布

- GitHub Release 提供 `omnimail-float-1.0.0.zip`，并使用 `float-v1.0.0` 独立 Tag。
- Chrome Web Store 条目 `fpeecjailboemocpmpcbjaghpkpcaihf` 已于 2026-09-04 提交
  `1.0.0` 审核，并设置为审核通过后自动发布；审核期间公开版本继续保持 `0.8.1`。
