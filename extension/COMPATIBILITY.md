# OmniMail Float 1.x 稳定兼容契约

本文定义 OmniMail Web/API 与 Float `1.x` 之间的稳定边界。它覆盖官方邮箱来源、能力
枚举、账号状态和通知深链接；不把尚未版本化的公共 HTTP API 宣布为通用第三方标准。

## 兼容范围

- Float `1.x` 连接 Web/API `1.x`，同一主版本内保持向后兼容。
- `1.x` 可以增加可选字段或可选能力，旧客户端必须仍能完成原有操作。
- 删除或重用来源 ID、修改既有状态/能力语义、改变深链接路径或必需查询参数，属于破坏性
  变更，必须进入新的主版本并提供迁移说明。
- 第三方账号连接、凭据更新和身份管理继续只在 Web 完成；Float 不接收这些凭据。

## 官方来源矩阵

| 来源 | 稳定 ID | Web 路径 | 阅读 | 附件 | 文件夹/同步 | 发信/回复 |
| --- | --- | --- | --- | --- | --- | --- |
| OmniMail | `omnimail` | `/mail/inbox` | 是 | 是 | — | 发信、回复、草稿 |
| iCloud Hide My Email | `icloud` | `/icloud` | 是 | — | — | — |
| Linux DO Mail | `linuxdo` | `/linux-do-mail` | 是 | — | 实时读取 | 无附件发信 |
| Gmail | `gmail` | `/gmail` | 是 | 是 | 主动同步 | — |
| Microsoft Mail | `microsoft` | `/microsoft` | 是 | 是 | 文件夹、主动同步 | — |
| QQ 邮箱 | `qq` | `/qq-mail` | 是 | 是 | 主动同步 | 发信、回复 |
| NAVER Mail | `naver` | `/naver-mail` | 是 | 是 | 主动同步 | — |
| Yandex Mail | `yandex` | `/yandex-mail` | 是 | 是 | 主动同步 | — |

“—”表示 Web/API 当前没有向 Float 提供该能力，不代表未来版本承诺。新增能力必须使用
独立 Scope，并由用户明确重新授权；刷新已有令牌不能静默扩大权限。

## 稳定数据语义

Float 对账号状态只暴露以下值：

- `active`：账号可正常使用。
- `syncing`：账号存在且正在完成服务端同步。
- `error`：账号仍显示，并通过 `needsAttention: true` 引导用户前往 Web 修复。

能力对象固定使用五个布尔字段：`attachments`、`folders`、`reply`、`send`、`sync`。
字段为 `false` 时界面不得展示对应操作，也不得绕过服务端直接访问第三方接口。

## 通知深链接

通知目标使用对应来源的稳定 Web 路径，并保留以下查询参数：

```text
?source=<稳定来源ID>&accountId=<账号ID>&messageId=<邮件ID>
```

参数必须通过 URL 编码；未知来源、危险来源地址或不属于当前用户的数据继续由客户端和
服务端拒绝。点击通知可以复用已有同路径标签页，但不得把扩展内部 `panel.html` 当作
普通网页打开。

## 变更门禁

`extension/src/stable-contract.test.ts` 固定检查：

1. 八个官方来源 ID、账号状态和能力名称没有漂移。
2. Web 工作区与 Float 使用相同的来源路径。
3. 通知设置、深链接和来源清单保持一一对应。
4. Indexed 来源继续使用固定 OmniMail API 入口。
5. Provider 特有错误继续归一为可见、可修复的 `error` 状态。

任何正式来源变更都必须同时更新本文件、共用注册表、适配器、授权 Scope、商店披露和
相应测试。不能只修改 Web 或 Float 的单侧清单。
