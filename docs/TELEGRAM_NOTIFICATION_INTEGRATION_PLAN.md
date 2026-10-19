# Telegram 新邮件通知接入计划

- 状态：Web `1.2.0` 发布候选已在 `codex/release-web-1.2.0` 完成本地发布检查，待合入 `main` 正式发版；真实 Bot 私聊联调仍待验收
- 计划日期：2026-09-27
- 需求来源：[Issue #13：TG 或其他渠道推送](https://github.com/mibgb65-cloud/OmniMail/issues/13)
- 首版边界：一个自托管实例使用一个 Telegram Bot；每位 OmniMail 用户绑定一个 Telegram 私聊；只推送新邮件提醒

## 1. 目标与取舍

用户无需保持网页或 Float 扩展运行，也能在 Telegram 收到自己邮箱的新邮件提醒。首版覆盖
OmniMail 主邮箱及已建立 IMAP 索引的 iCloud、Linux DO、Gmail、Microsoft、QQ、NAVER、
Yandex 八类来源。通知只在新邮件成功入库或索引后产生；已读、星标、正文刷新和重复同步不触发。

首版只接入 Telegram 私聊。群组、频道、回复邮件、转发完整邮件、用户自带 Bot、多渠道同时投递
和任意 URL Webhook 留待后续需求。为了回应 Issue 中“公共类”的建议，事件、用户筛选和投递记录
设计为渠道无关；首版只实现一个 Telegram 发送器，不预建一套空泛的渠道插件框架。

默认通知内容为“来源邮箱收到新邮件”和指向 OmniMail 的链接。用户可单独开启发件人与主题；
默认情况下正文、预览、附件和验证码不进入 Telegram 消息。后续已增加仅限 OmniMail 主邮箱的
可选完整纯文本正文转发：短正文直接发送，较长正文作为文本文件，超限时提示回站内查看。
后续增加了可选 Telegram 富文本格式，服务端仅转换常用 HTML 结构与安全链接，图片和复杂样式
仍通过站内链接查看；转换失败时回退纯文本。
Telegram 是第三方服务，设置页需要说明
开启详细内容后，发件人和主题会离开当前自托管实例。

## 2. 现有架构与接入位置

| 现有能力 | 代码位置 | 对本方案的影响 |
| --- | --- | --- |
| 八来源通知摘要 API | `email-worker/src/features/notifications/mail-notification-api.ts` | 供客户端读取当前列表和未读数，是快照，不作为新邮件事件源 |
| Float 每分钟轮询和本机提醒 | `extension/src/notification-poll.ts`、`extension/src/background.ts` | 来源开关和免打扰交互可参考；设置保存在浏览器本机，不能充当服务端 Telegram 设置 |
| 主邮箱解析队列 | `email-worker/src/app/handlers/mail.ts` | `parseMessage()` 将邮件更新为 `ready` 时生成待发事件 |
| 七类外部邮箱同步 | 各来源的 `*-sync.ts`，iCloud/Linux DO 共用 `external-mail-sync.ts` | 只针对首次插入且属于 INBOX 的邮件生成事件 |
| 每五分钟计划任务 | `email-worker/src/index.ts`、`email-worker/src/platform/scheduling/cleanup.ts` | 可补扫待投递记录，修复 D1 已提交但 Queue 写入失败的间隙 |
| 现有邮件队列 | `MAIL_QUEUE` | 承担解析、同步和发信；Telegram 使用独立 Queue，避免外部服务故障拖慢收发信 |

外部邮箱由定时同步发现来信，因此 Telegram 到达速度受现有同步周期影响，不承诺秒级推送。
iCloud Web 摘要没有可靠的 IMAP 索引与已读状态，不纳入首版服务端推送。

| 方案 | 好处 | 主要问题 | 结论 |
| --- | --- | --- | --- |
| 定时读取 `/api/mail-notifications` 并转发 | 复用现有查询 | 返回的是快照，已读变化和候选截断会导致误判或漏发 | 不采用 |
| D1 待发记录 + 现有 `MAIL_QUEUE` | 少一个资源绑定 | Telegram 故障或限流会与收发信、邮箱同步争用队列 | 不采用 |
| D1 待发记录 + 独立通知 Queue | 新邮件判定、去重和重试清晰；故障隔离 | 增加迁移与 Queue 绑定 | 首版采用 |

## 3. 用户流程

1. 实例管理员通过 Cloudflare Secret 配置 `TELEGRAM_BOT_TOKEN` 和
   `TELEGRAM_WEBHOOK_SECRET`。缺少任一项时入口显示“未配置”，不影响现有邮件服务。
2. 管理员在系统设置中验证 Bot 身份（Telegram `getMe`），再注册或重新注册 Webhook。
   Webhook 地址来自已核准的本站 HTTPS Origin，不接受任意用户输入的回调地址。
3. 用户在“通知与提醒”中点击“连接 Telegram”。服务端产生短期、一次性随机码并只保存哈希；
   页面打开 `https://t.me/<bot_username>?start=<code>`。Telegram 私聊中的 `/start` 到达
   Webhook 后绑定该用户与 `chat.id`，页面显示已连接并可发送一条测试消息。
4. 用户选择来源、是否包含发件人和主题、是否启用免打扰；可测试、暂停、解除绑定。
   首版免打扰期间直接跳过提醒，不在结束后集中补发，页面需明确说明。
5. 用户点击提醒后打开已登录的 OmniMail 对应工作区；链接不带登录凭据，未登录时正常进入登录流程。

Bot 不能先向用户发起私聊，因此用户必须主动打开连接链接并发送 `/start`。配对码建议使用
至少 24 字节安全随机数、base64url 编码，十分钟过期且只能消费一次；只接受 Telegram
`private` 类型的聊天，不以可更改的用户名作为身份依据。

## 4. 数据与投递设计

新增下一号 D1 迁移（预计 `0038_telegram_notifications.sql`），并更新 Worker 运行时的迁移
镜像及测试。建议三张表，字段名在实施时与现有 D1 命名规范对齐：

| 表 | 最小字段与约束 | 用途 |
| --- | --- | --- |
| `notification_endpoints` | `id`、`user_id`、`chat_id`、`enabled`、来源集合、内容级别、免打扰时区与时段、`enabled_at`、错误状态；`UNIQUE(user_id)`，已绑定私聊的 `chat_id` 在实例内唯一 | 每位用户的 Telegram 私聊绑定与服务端偏好；未来新增渠道时再扩展渠道字段，`chat_id` 按十进制字符串保存 |
| `telegram_pairing_codes` | `code_hash`、`user_id`、`expires_at`、`consumed_at`；过期记录定期清理 | 一次性配对；数据库不保存明文码 |
| `notification_outbox` | `id`、`endpoint_id`、`source`、`account_id`、`message_id`、状态、尝试次数、下次尝试时间、租约、创建/发送时间、脱敏错误码；`UNIQUE(endpoint_id, source, account_id, message_id)`，并按状态和下次尝试时间建索引 | 持久去重、失败重试与投递状态；不复制正文或主题 |

新邮件事件由 D1 `AFTER INSERT` / `AFTER UPDATE OF status` 触发器写入，因此与邮件索引
写入处于同一事务；D1 的 `batch()` 失败时整批回滚。待发记录使用受约束的
`INSERT OR IGNORE`，避免重复事件导致邮件事务失败。
消息成功入库后再尝试将 outbox ID 放入独立 `NOTIFICATION_QUEUE`；入队异常只记录脱敏
错误，不把已经成功的收信或同步改成失败。定时任务按
`next_attempt_at` 有界补扫待发记录，因此数据库提交后即使暂时无法入队也不会永久漏发。
队列消费者先通过 D1 条件更新取得短租约，再重新检查用户绑定、来源开关、消息归属、
是否仍在收件箱及是否已读；已读或已删除的邮件可标为跳过。
未绑定或暂停 Telegram 的用户不写 outbox；补扫只读待发索引，不定时扫描所有邮件表。
暂停或解绑时取消该端点未发送的记录；重新启用时更新 `enabled_at`，不补发暂停期间的邮件。

新邮件判定必须基于首次插入的稳定来源键，不用 `UPSERT` 的 `meta.changes` 代替：
重复同步和已读标志变化也可能产生数据库写入。外部来源只在 `AFTER INSERT` 时触发，
并要求账号已完成首次同步、UIDVALIDITY 与当前账号或文件夹一致、新 UID 高于已扫描水位；
账号同步租约和 outbox 唯一约束共同抵御并发重试。主邮箱只在解析成功、状态变为
`ready` 时触发，解析失败或待处理状态均不推送。

为避免历史邮件轰炸：用户开启通知前的邮件不补发；新连接账号的首次同步以
`last_synced_at IS NULL` 建立基线，不生成事件；UIDVALIDITY 重置、重建索引和历史回填也只
重建基线。后续正常增量同步才推送新邮件。需要为这四类情况分别写回归测试。

## 5. Telegram 接口与安全边界

| 接口 | 权限 | 行为 |
| --- | --- | --- |
| `GET /api/notification-channels/telegram` | 当前登录用户 | 返回状态与偏好，不返回 Bot Token 或完整私聊标识 |
| `POST /api/notification-channels/telegram/pairing` | 当前登录用户 | 限速生成一次性连接链接；新码使旧码失效 |
| `PATCH /api/notification-channels/telegram` | 当前登录用户 | 校验来源白名单、内容级别、IANA 时区和时段后更新偏好 |
| `POST /api/notification-channels/telegram/test` | 当前登录用户 | 限速发送不含邮件数据的测试提醒 |
| `DELETE /api/notification-channels/telegram` | 当前登录用户 | 撤销绑定、清理配对码和未发送记录 |
| `POST /api/admin/notification-channels/telegram/webhook` | 管理员 | 验证 Bot 并向 Telegram 注册 Webhook；返回脱敏状态 |
| `POST /api/webhooks/telegram` | Telegram Webhook | 校验密钥请求头，只接受有限大小的 JSON 和预期的 `/start` 私聊消息 |

Webhook 必须先以固定时序比较验证 `X-Telegram-Bot-Api-Secret-Token`，再解析请求体；校验 HTTP 方法、
Content-Type、大小、`update_id`、聊天类型和配对码格式。重复 Webhook 更新返回成功但不
重复绑定。所有用户输入都限制类型、长度和枚举；任何角色都不能通过 API 自行指定任意
`chat_id`。Bot Token 只存在 Worker Secret，调用 Telegram 的 URL、日志、异常和审计中
均不得输出 Token、配对码或邮件内容。

发送 `sendMessage` 时使用 JSON POST 和纯文本，不启用 Markdown/HTML 解析；关闭链接
预览，限制最终文本长度，并只构造指向本站已知工作区的 URL。Telegram 返回成功后才标记
已发送；遇到限流按 `retry_after` 延迟，网络/5xx 按上限退避，明确的无效聊天或 Bot 被封锁
则暂停绑定并提示用户重新连接。Queue 是至少一次投递：唯一约束与租约降低重复，但若
Telegram 已收下消息而成功响应丢失，仍可能出现极少量重复，产品不承诺严格恰好一次。
管理员更换 Bot Token 或网站域名后必须重新验证并注册 Webhook；更换 Bot 时暂停旧私聊
绑定，要求用户与新 Bot 重新配对。

## 6. 实施顺序

1. **D1 与部署基础**：迁移、运行时 schema 镜像、`Env` 类型、独立通知 Queue 和死信队列；
   `npm run deploy` 继续先迁移再发布。Secret 缺失时功能安全关闭。
2. **Bot 配置与绑定**：管理员状态与 Webhook 注册、Webhook 验签、一次性配对、用户设置、
   解绑和测试消息；先在私聊完成真实 Bot 联调。
3. **主邮箱事件闭环**：在 `parseMessage()` 成功事务中写 outbox，队列投递、补扫和失败处理；
   完成重复解析、队列重投、已读前取消和用户隔离测试。
4. **七类外部来源**：逐个接入同步成功后的首次插入判定；iCloud/Linux DO 共用路径一起验证，
   其余各来源覆盖初次同步、增量同步、UID 重置、手动同步及重复同步。
5. **界面与发布**：Web 设置页、简体中文/英文文案、隐私提示、部署与故障排查文档；
   本地集成测试和真实 Telegram 私聊验收通过后，经 PR 合入并按发布流程打 Tag。

后续增加其他渠道时，复用 outbox 与来源筛选，新增对应发送器及目标配置。首版不开放
“任意 Webhook URL”，避免把服务器变成向用户指定地址发请求的代理。

## 7. 验收与上线检查

- **功能**：八类已索引来源的新邮件各触发一次提醒；已读、星标、正文读取和同步重试不触发。
  初次同步、索引重建、历史回填和 UID 重置不批量推送旧邮件。
- **隔离**：用户 A 无法绑定、测试或查看用户 B 的私聊；配对码过期、重用、群聊使用均失败。
- **可靠性**：D1/Queue 临时失败可恢复，Telegram 限流后延迟重试，永久错误可见且不无限重试；
  Telegram API 或通知 Queue 故障不影响收信、解析、外部邮箱同步或发信。
- **隐私**：默认消息不含发件人、主题、正文和验证码；Token、配对码、`chat_id` 及邮件内容
  不进入日志。解除绑定后不再发送，新绑定不补发历史邮件。
- **发布**：D1 迁移本地和 Worker 集成测试通过；`npm run check`、Web/扩展构建、相关 E2E
  与生产 Bot 私聊验证通过。上线后观察待发量、失败码与重复率，不记录邮件正文。

迁移只新增表和索引，旧版 Worker 不依赖这些对象。需要回滚时先停用 Telegram Webhook
和通知 Queue 消费，再回滚 Worker；保留未发记录供排查，不删除原有邮件数据。
待发记录与邮件写入共用 D1 事务，若新迁移缺失或 SQL 有缺陷，仍可能阻断对应邮件写入；
上线前必须由部署脚本完成迁移、运行事务回归测试，并在测试实例验证有无 Bot Secret 两种配置。

## 参考资料

- [Telegram Bot API：`sendMessage`、`setWebhook` 与错误响应](https://core.telegram.org/bots/api)
- [Telegram Bot 深链接](https://core.telegram.org/bots/features#deep-linking)
- [Cloudflare D1 `batch()` 事务语义](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Cloudflare Queues 至少一次投递保证](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
