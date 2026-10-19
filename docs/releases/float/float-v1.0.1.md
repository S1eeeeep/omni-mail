### 更新摘要

- 修复悬浮面板中 Gmail、QQ、NAVER、Yandex、Microsoft 五类索引邮箱的来信时间显示为
  1970 年的问题。
- 服务端返回的是秒级时间戳，扩展此前按毫秒解析，现在自动识别并归一化。

### 修复

- `normalizeIndexedMessage` 直接把数字时间戳交给 `new Date()`，而五类 IMAP 来源的摘要
  `date` 字段是秒级 Unix 时间戳（Web 端一直使用 `date * 1000`），导致面板里每封邮件都显示
  成 1970 年 1 月。
- 新增 `normalizeIndexedDate()`：小于 `100000000000` 的值按秒处理并转换为毫秒，毫秒级
  时间戳原样保留；ISO 日期字符串继续走 `Date.parse()`，数字字符串按数值兜底，无效值归零。
  阈值两侧分别是公元 5138 年和 1973 年，不可能是真实邮件时间，现有毫秒时间戳不会被误乘。
- `PanelIndexedInbox` 的 `formatDate()` 增加同样的归一化，保证详情与列表展示一致。
- Linux DO 的 `date` 是 ISO 字符串、OmniMail 主邮箱是毫秒，两条路径行为不变。

### 兼容性

- 需要 OmniMail Web/API `1.0.0` 或更高兼容版本，以及 Chrome 120 或更高版本。
- 不新增 Chrome 权限、设备令牌 Scope、远程代码或数据处理类型，不需要重新授权。
- Float `1.0.0` 可直接覆盖升级，现有登录、设置和来源选择继续保留。
- Chrome Web Store 固定扩展 ID 保持 `fpeecjailboemocpmpcbjaghpkpcaihf`。

### 安装与升级

- Chrome Web Store 条目提交 `1.0.1` 审核，审核期间公开版本继续保持 `1.0.0`。
- 已安装 `1.0.0` 的用户在商店更新后自动覆盖升级，无需重新授权或重新配置来源。
- 开发者模式可使用本 Release 提供的 `omnimail-float-1.0.1.zip`。

### 测试

- 新增单元用例覆盖秒级、毫秒级、ISO 字符串、数字字符串与无效时间戳的归一化结果。
- 785 项单元测试、32 项 Worker/D1 集成测试、类型检查、Oxlint 与扩展生产构建通过。
- 真实 Chromium 扩展 smoke 测试通过；`npm run deploy --dry-run` 通过。
- 已在 GitHub Actions 对 fork PR 重新运行完整 CI，全部通过后合并。

### 发布

- Float 版本为 `1.0.1`，通过 GitHub Tag `float-v1.0.1` 发布，Release 附带
  `omnimail-float-1.0.1.zip`。
- 本 Release 标记为非 Latest，确保 `/releases/latest` 继续代表 Web 版本。
