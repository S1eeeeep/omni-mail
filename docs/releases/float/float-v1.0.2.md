### 更新摘要

- 悬浮面板的邮件列表通过字重和未读状态点更清晰地区分已读与未读。
- iCloud IMAP 邮件打开后，列表会同步显示服务端返回的已读状态。

### 改进

- 普通邮箱和外部邮箱列表的已读发件人、主题使用常规字重；未读发件人、主题加粗，预览更醒目。
- 最近邮件列表也采用更明确的常规与粗体字重差异。
- iCloud IMAP 列表对明确标记为未读的邮件显示状态点和粗体；iCloud Web 摘要缺少准确状态时保持中性显示。

### 兼容性

- 需要 OmniMail Web/API `1.0.0` 或更高兼容版本，以及 Chrome 120 或更高版本。
- 不新增 Chrome 权限、设备令牌 Scope、远程代码或数据处理类型，无需重新授权。
- Float `1.0.1` 可直接覆盖升级，已有登录和设置继续保留。

### 安装与升级

- GitHub Release 提供 `omnimail-float-1.0.2.zip`，可用于开发者模式安装或覆盖升级。
- Chrome Web Store 版本需单独上传并通过商店审核；GitHub Release 不代表商店已更新。

### 测试

- 扩展生产构建和 Chromium smoke 测试通过；完整 CI 在发布 Tag 前执行。

### 发布

- Float 版本为 `1.0.2`，通过 GitHub Tag `float-v1.0.2` 发布，Release 附带
  `omnimail-float-1.0.2.zip`。
- 本 Release 标记为非 Latest，确保 `/releases/latest` 继续代表 Web 版本。
