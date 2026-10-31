# 隐私邮箱取码服务的主动推送

OmniMail 为明确订阅的自有主邮箱推送收件事件和正文。取码服务可从本地返回验证码，无需逐次查询 `/api/messages` 或下载正文。

## 配置和部署

- 本仓库的 `main` 更新后沿用 Workers Builds：`npm run build`，然后 `npm run deploy`。
- 部署脚本只为新增推送功能检查/创建 `omnimail-mail-push` 与 `omnimail-mail-push-dead` 两个专用队列；构建身份需要 Queues 编辑权限。原有 D1 仍按线上实际绑定 ID 定位，SQL0042 通过部署迁移命令执行；应用请求不会自动执行这份 SQL。
- 签名密钥使用既有全局 `MAIL_CREDENTIALS_KEY` 或 `ICLOUD_CREDENTIALS_KEY` 加密。禁止提交这些 Secret 或真实推送密钥到 Git。
- 下游使用完整设备令牌调用 `PUT /api/integrations/mail-push`，提交订阅 UUID、独立的32字节随机base64url密钥、固定 HTTPS 回调地址、明确的主邮箱列表。邮箱必须属于当前用户；重复配置保留事件和进度。
- 回调路径固定 `/api/integrations/omnimail/events`，HTTPS、443、公开域名，无用户名、查询参数或片段。签名密钥不是管理令牌或单邮箱取码凭据。

## 投递协议 v1

POST JSON 包含 `version=1`、`subscription_id`、`generated_at`（Unix毫秒）、`streams` 和 `events`。

每条 stream：`mailbox`、`high_water`（该订阅/主邮箱的连续事件高水位）、`initialized`。每个事件包含稳定 `id`、`sequence`、`message_id`、`mailbox`、`state`（processing/ready/failed）、实际 `received_at`、邮件头日期 `message_date`、必要路由 `headers`、`recipients`、`sender`、`subject`、`text`、`text_hash`，错误有 `error_code`。

处理流程：

1. 收信/状态变更与不可变事件快照在同一个 D1 batch 保存，邮件删除或 R2 对象清理不影响尚未确认的快照。
2. 先推有界批次的归属元数据；ready 的元数据有 `metadata_only=true`、空 text、实际完整正文的SHA256。接收端因此知道待到的正文属于哪些 alias，并能发现序号缺口。
3. 再分批推正文：沿用同一事件 ID/序号/元数据与 `text_hash`，`metadata_only` 缺省或 false。接收端校验正文后，仅结束该邮件的待处理状态。其他 alias 的正文无需全部完成。
4. 接收端事务落地后返回 `200 {"status":"accepted"}`；丢失回执可用同一事件重投。已确认快照删除 text 字段以减少重复存储，保留事件身份和摘要；未确认/失败快照不清理。
5. 失败指数退避和抖动，20次后持久标记失败。`POST /api/integrations/mail-push/retry` 可重排当前用户的失败投递；解析失败与投递失败分别处理。

签名请求头：

- `X-OmniMail-Subscription`：订阅 ID。
- `X-OmniMail-Delivery`：每次请求新 UUID。
- `X-OmniMail-Timestamp`：本次发送的Unix秒。
- `X-OmniMail-Signature`：HMAC-SHA256十六进制，输入为 `timestamp + "\n" + delivery + "\n" + 原始请求体`，密钥使用配置的base64url字符串本身。

重试保留事件 ID 和内容，重新产生发送时间/请求 ID/签名。接收端验证签名、时间、来源/订阅和邮箱范围；不能直接相信载荷中的 To、主邮箱或任何任意 account_id。

## 进度和资源

- 首次订阅分页补投最近24小时，游标按实际创建时间和ID持久化，并与实时快照去重。实际接收时间用于投递次序，邮件 Date 单独保存。
- 每分钟维护只补发待投递和无信健康检查点，不由下游轮询邮件。各主邮箱的进度分开，不能用全用户列表版本替代。
- 专用队列最多4个消费者，每个主邮箱使用有期限租约；成功处理下一批重新入队，不把正常分页消耗为故障重试。HTTP载荷约束在3MiB内，正常正文JSON限制512KiB；超限明确报待处理错误，不伪造成功取码。
- 下游初始化、序号缺口、未完成相关正文、归属冲突或失联必须可见。健康推送表示已同步进度，异步传输不代表远端瞬时最新。
- 日志与审计不记录正文、验证码、密钥或完整路由头。只读接收不改变上游已读、不删邮件、不发送外部邮件。

验证：真实 workerd/D1/R2 夹具覆盖收信/解析的同事务快照、元数据与正文分离、HMAC、丢回执/重复投递、原邮件删除后仍可重试、首次回填和幂等序号。夹具验证不等于生产真实到信或750封公网吞吐验收。
