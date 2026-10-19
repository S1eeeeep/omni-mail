# Telegram 新邮件提醒

OmniMail 可以将八类已索引邮箱来源的新邮件提醒发送到用户自己的 Telegram 私聊。
这是可选功能；不配置 Bot Secret 时，原有收信、同步和发信继续工作。

## 管理员配置

1. 使用 Telegram [@BotFather](https://t.me/BotFather) 创建一个 Bot。一个 OmniMail 实例使用一个 Bot。
2. 在 Cloudflare Worker 的 **Settings → Variables and Secrets** 添加两个 Secret：
   `TELEGRAM_BOT_TOKEN` 为 Bot Token；`TELEGRAM_WEBHOOK_SECRET` 为独立生成的
   16–256 位随机字符串，只使用英文字母、数字、`_` 和 `-`。不要把值写进 Git、聊天或日志。
3. 更新仓库后运行 `npm run build` 和 `npm run deploy`。部署脚本会先应用
   `0038_telegram_notifications.sql`、`0039_telegram_message_body.sql` 和
   `0040_telegram_rich_body.sql`，再发布独立通知 Queue。
4. 用 HTTPS 正式站点登录主管理员账号，进入**账号设置 → Telegram 新邮件提醒**，点击
   **验证并注册 Telegram Bot**。这会使用当前站点 Origin 注册
   `/api/webhooks/telegram`，并在设置页显示 Bot 已配置。

Webhook 必须指向可从 Telegram 访问的 HTTPS 站点；本机 `localhost` 不能作为正式 Webhook。
更换站点域名后，需在新域名上重新点击注册。更换为另一个 Bot 时，旧私聊连接会被暂停，
用户需要与新 Bot 重新配对。

## 用户连接与通知设置

1. 在**账号设置 → Telegram 新邮件提醒**点击**连接 Telegram**。
2. 在打开的 Telegram 私聊中点击**开始**。连接码十分钟有效，只能使用一次。Bot 不能主动
   给尚未开始聊天的用户发消息。若浏览器阻止弹窗，可点击页面上的连接链接。
3. 页面显示已连接后，可选择来源、消息内容级别、免打扰时段与 IANA 时区，并发送测试消息。
   每位用户只能绑定一个私聊，一个私聊也只能绑定当前实例中的一个用户。

默认消息只包含来源和打开 OmniMail 的链接；发件人和主题需要用户主动开启。用户还可单独
勾选**发送 OmniMail 主邮箱正文**，默认关闭。正文格式默认是纯文本，也可选择 **Telegram 富文本**。
开启后，主邮箱新邮件的正文会发送给 Telegram，其中可能包含验证码等敏感信息；外部邮箱不发送
正文。纯文本短正文直接放在提醒中，较长正文作为 `.txt` 文件发送。富文本会转换标题、段落、
强调、列表、表格和 HTTPS 链接，不执行邮件 CSS 或脚本，也不自动加载远程图片；图片位置仅显示
文字提示，原图和复杂排版需在站内查看。HTML 缺失、过大、过于复杂或 Telegram 拒绝富文本时，
回退到纯文本。正文超过 1 MB、存储对象超过 5 MB、正文缺失或读取失败时，仍发送带站内链接的
提醒，并提示回站内查看。附件不会转发。Telegram 是第三方服务；
链接不含登录令牌，打开时仍需按 OmniMail 的认证流程登录。

免打扰期间的新邮件提醒会跳过，不会在时段结束后补发。已读、星标变化和重复同步不会
生成新提醒；用户首次连接某个外部邮箱、UIDVALIDITY 重置或重建索引时不会推送历史邮件。
外部邮箱的提醒速度受现有同步周期影响，不保证秒级到达。iCloud Web 摘要没有可用的
服务端 IMAP 索引，不参与这项推送。

## 运维与故障排查

- **显示未配置**：确认两个 Secret 均已设置，并由主管理员从正式 HTTPS 站点注册 Webhook。
- **配对失败**：确认点击的是私聊链接、码未过期，且该私聊没有绑定给其他 OmniMail 用户。
- **测试消息失败**：确认未屏蔽 Bot；测试操作每分钟最多一次。Bot 被屏蔽时，连接会暂停。
- **新邮件未提醒**：检查来源是否勾选、是否已读、是否处于免打扰时段，以及外部邮箱的
  最近同步状态。通知有独立 Queue 和死信队列，不与收发信队列共用。
- **网络或限流**：临时失败会退避重试；队列可能至少一次投递，极少数情况下可能出现重复提醒。
  日志只记录脱敏错误码，不记录 Bot Token、配对码、私聊 ID 或邮件内容。

停用功能时，先在用户设置中暂停或解除连接；管理员还应从 Telegram 端移除该 Bot 的
Webhook，再移除 Worker Secret。回滚到旧版 Worker 前先停止通知 Queue 消费，保留 D1
新增表供排查。原有邮件数据不会因解除 Telegram 连接而删除。

协议参考：[Telegram Bot API](https://core.telegram.org/bots/api)、
[Telegram Bot 深链接](https://core.telegram.org/bots/features#deep-linking)。
