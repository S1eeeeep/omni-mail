<!-- 此文件由 npm run docs:api 自动生成，请修改 src/features/api-guide/model/apiCatalog*.ts 后重新生成。 -->

# 管理员：用户与访问

**Admin: users and access**

邀请、用户、用户限速和收件域名管理。

> Invitations, users, user rate limits, and receiving-domain management.

本分类共 **16** 个端点。返回 [完整 API 索引](README.md) 或 [API 架构与安全说明](../API.md)。

<!-- endpoint:GET /api/admin/invites catalog:208df68a46d2 -->
## `GET /api/admin/invites`

**查询邀请记录 / Query invitations**

分页读取管理员创建的邀请、使用次数、状态和权限策略。

> Page through invitations with usage, status, and policy details.

| 项目 | 内容 |
| --- | --- |
| 认证 | 管理员或主管理员 |
| 请求 | Query · limit?, cursor? |
| 成功响应 | 200 · { invites, page } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/admin/invites?limit=30" \
  --header "Authorization: Bearer om_at_admin..."
```

<!-- endpoint:POST /api/admin/invites catalog:494316649e22 -->
## `POST /api/admin/invites`

**创建账户邀请 / Create an account invitation**

创建单次或多次、指定地址或自选地址的用户邀请。

> Create single- or multi-use invitations with assigned or self-selected addresses.

| 项目 | 内容 |
| --- | --- |
| 认证 | 管理员或主管理员 |
| 请求 | JSON · domain, accountRole, expiresInHours, accountLifetimeHours?, multiUse, addressMode, assignedLocalPart?, mailboxLimit, canCreateMailboxes, canReply, canTranslate |
| 成功响应 | 201 · { invite, token } |

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/admin/invites" \
  --header "Authorization: Bearer om_at_admin..." \
  --header "Content-Type: application/json" \
  --data '{
  "domain": "example.com",
  "accountRole": "user",
  "expiresInHours": 24,
  "accountLifetimeHours": 0,
  "multiUse": false,
  "addressMode": "self_selected",
  "assignedLocalPart": "",
  "mailboxLimit": 1,
  "canCreateMailboxes": true,
  "canReply": false,
  "canTranslate": false
}'
```

<!-- endpoint:PATCH /api/admin/invites/:id/revoke catalog:df16b860293f -->
## `PATCH /api/admin/invites/{id}/revoke`

**撤销邀请 / Revoke an invitation**

立即使指定邀请失效，不影响已创建的账户。

> Invalidate the invitation immediately without changing accounts already created from it.

| 项目 | 内容 |
| --- | --- |
| 认证 | 管理员或主管理员 |
| 请求 | Path · id |
| 成功响应 | 200 · { ok: true } |

### cURL 示例

```bash
curl --request PATCH \
  --url "https://mail.example.com/api/admin/invites/resource_id/revoke" \
  --header "Authorization: Bearer om_at_admin..."
```

<!-- endpoint:GET /api/admin/users catalog:00be843cd1cf -->
## `GET /api/admin/users`

**查询用户目录 / Query the user directory**

分页读取用户、邮箱数量、配额与发信用量。

> Page through users, mailbox counts, quotas, and sending usage.

| 项目 | 内容 |
| --- | --- |
| 认证 | 管理员或主管理员 |
| 请求 | Query · limit?, cursor? |
| 成功响应 | 200 · { users, totals, page } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/admin/users?limit=50" \
  --header "Authorization: Bearer om_at_admin..."
```

<!-- endpoint:POST /api/admin/users catalog:200cb9de2897 -->
## `POST /api/admin/users`

**创建托管用户 / Create a managed user**

由管理员直接创建账户并设置角色、配额和功能权限。

> Let an administrator create an account with role, quota, and feature permissions.

| 项目 | 内容 |
| --- | --- |
| 认证 | 管理员或主管理员 |
| 请求 | JSON · email, displayName, password, role?, status?, mailboxLimit?, storageQuotaMiB?, canCreateMailboxes?, canReply?, canTranslate? |
| 成功响应 | 201 · { user } |

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/admin/users" \
  --header "Authorization: Bearer om_at_admin..." \
  --header "Content-Type: application/json" \
  --data '{
  "email": "member@example.com",
  "displayName": "Member",
  "password": "strong-password",
  "role": "user",
  "status": "active",
  "mailboxLimit": 1,
  "storageQuotaMiB": 1024,
  "canCreateMailboxes": true,
  "canReply": false,
  "canTranslate": false
}'
```

<!-- endpoint:PATCH /api/admin/users/:id catalog:2caa420d1248 -->
## `PATCH /api/admin/users/{id}`

**更新用户策略 / Update a user policy**

修改非主管理员用户的角色、状态、邮箱上限、配额和能力。

> Change role, status, mailbox limit, quota, and capabilities for a non-owner user.

| 项目 | 内容 |
| --- | --- |
| 认证 | 管理员或主管理员 |
| 请求 | Path · id; JSON · role?, status?, mailboxLimit?, storageQuotaMiB?, canCreateMailboxes?, canReply?, canTranslate? |
| 成功响应 | 200 · { user } |

### cURL 示例

```bash
curl --request PATCH \
  --url "https://mail.example.com/api/admin/users/resource_id" \
  --header "Authorization: Bearer om_at_admin..." \
  --header "Content-Type: application/json" \
  --data '{
  "status": "active",
  "mailboxLimit": 3,
  "canReply": true
}'
```

<!-- endpoint:PATCH /api/admin/users/:id/outbound-rate-limit catalog:05b21257558a -->
## `PATCH /api/admin/users/{id}/outbound-rate-limit`

**覆盖用户发信限速 / Override a user sending limit**

为指定用户设置每分钟和每日限额；null 表示继承全局值。

> Set per-minute and daily limits for a user; null inherits the global value.

| 项目 | 内容 |
| --- | --- |
| 认证 | 管理员或主管理员 |
| 请求 | Path · id; JSON · minuteLimit: number\|null, dayLimit: number\|null |
| 成功响应 | 200 · { outboundRateLimit } |

### cURL 示例

```bash
curl --request PATCH \
  --url "https://mail.example.com/api/admin/users/resource_id/outbound-rate-limit" \
  --header "Authorization: Bearer om_at_admin..." \
  --header "Content-Type: application/json" \
  --data '{
  "minuteLimit": 5,
  "dayLimit": 100
}'
```

<!-- endpoint:POST /api/admin/users/:id/outbound-rate-limit/reset catalog:d1f9739821bb -->
## `POST /api/admin/users/{id}/outbound-rate-limit/reset`

**清零用户发信计数 / Reset a user sending counter**

清零指定用户当前分钟和 UTC 自然日的发信计数。

> Reset the user’s current minute and UTC-day send counters.

| 项目 | 内容 |
| --- | --- |
| 认证 | 管理员或主管理员 |
| 请求 | Path · id |
| 成功响应 | 200 · { outboundRateLimit } |

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/admin/users/resource_id/outbound-rate-limit/reset" \
  --header "Authorization: Bearer om_at_admin..."
```

<!-- endpoint:POST /api/admin/domains catalog:f6243e6c8e26 -->
## `POST /api/admin/domains`

**添加收件域名 / Add a receiving domain**

把已配置 Email Routing 的域名加入 OmniMail 管理。

> Add a domain with configured Email Routing to OmniMail management.

| 项目 | 内容 |
| --- | --- |
| 认证 | 管理员或主管理员 |
| 请求 | JSON · name |
| 成功响应 | 201 · { domain } |

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/admin/domains" \
  --header "Authorization: Bearer om_at_admin..." \
  --header "Content-Type: application/json" \
  --data '{
  "name": "example.com"
}'
```

<!-- endpoint:PATCH /api/admin/domains/:name catalog:cfa9489fe5aa -->
## `PATCH /api/admin/domains/{name}`

**启停收件域名 / Enable or disable a receiving domain**

修改域名启用状态，关闭后停止该域名地址的收件和发信。

> Change domain active state; disabling stops receiving and sending for its addresses.

| 项目 | 内容 |
| --- | --- |
| 认证 | 管理员或主管理员 |
| 请求 | Path · name; JSON · isActive |
| 成功响应 | 200 · { domain } |

### cURL 示例

```bash
curl --request PATCH \
  --url "https://mail.example.com/api/admin/domains/example.com" \
  --header "Authorization: Bearer om_at_admin..." \
  --header "Content-Type: application/json" \
  --data '{
  "isActive": false
}'
```

<!-- endpoint:DELETE /api/admin/domains/:name catalog:af479b857e9f -->
## `DELETE /api/admin/domains/{name}`

**移除域名配置 / Remove domain configuration**

默认仅删除空域名；显式 mode=configuration 保留关联邮箱与历史数据，但停止新收发、创建与邀请注册。

> The default only removes empty domains. Explicit mode=configuration retains mailbox history while stopping new mail flow, creation and invitation registration.

| 项目 | 内容 |
| --- | --- |
| 认证 | 管理员或主管理员 |
| 请求 | Path · name; Query · mode=configuration? |
| 成功响应 | 200 · { ok: true } |

### cURL 示例

```bash
curl --request DELETE \
  --url "https://mail.example.com/api/admin/domains/example.com?mode=configuration" \
  --header "Authorization: Bearer om_at_admin..."
```

<!-- endpoint:GET /api/admin/domains/:name/mailboxes catalog:ea931c73478a -->
## `GET /api/admin/domains/{name}/mailboxes`

**查看域名关联邮箱 / List associated mailboxes**

按精确域名分页查看所有用户的关联邮箱、主邮箱和清理状态。

> Paginate associated mailboxes across users, including primary and cleanup states, for an exact domain.

| 项目 | 内容 |
| --- | --- |
| 认证 | 管理员或主管理员 |
| 请求 | Path · name; Query · limit?, cursor? |
| 成功响应 | 200 · { mailboxes, totals, page, activeJob } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/admin/domains/example.com/mailboxes" \
  --header "Authorization: Bearer om_at_admin..."
```

<!-- endpoint:POST /api/admin/domains/:name/cleanup/preview catalog:c4c199cf6f39 -->
## `POST /api/admin/domains/{name}/cleanup/preview`

**预览关联邮箱清理 / Preview mailbox cleanup**

预览选中邮箱或全域关联邮箱清理，主邮箱和既有清理任务会阻止提交；预览有效期十分钟。

> Preview selected or all associated mailboxes. Primary mailboxes and existing cleanup tasks block submission; previews expire after ten minutes.

| 项目 | 内容 |
| --- | --- |
| 认证 | 仅主管理员 |
| 请求 | Path · name; JSON · mode=selected\|all_and_remove, addresses? (最多 100 个) |
| 成功响应 | 200 · { jobId, expiresAt, summary } |

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/admin/domains/example.com/cleanup/preview" \
  --header "Authorization: Bearer om_at_owner..." \
  --header "Content-Type: application/json" \
  --data '{
  "mode": "selected",
  "addresses": [
    "alias@example.com"
  ]
}'
```

<!-- endpoint:POST /api/admin/domains/:name/cleanup catalog:669c6fc62e87 -->
## `POST /api/admin/domains/{name}/cleanup`

**提交关联邮箱清理 / Submit mailbox cleanup**

凭当前操作者的预览与完整域名确认提交后台任务；重复使用同一 jobId 不扩大范围。

> Submit a background task using the current actor’s preview and full-domain confirmation. Repeating a jobId does not expand its scope.

| 项目 | 内容 |
| --- | --- |
| 认证 | 仅主管理员 |
| 请求 | Path · name; JSON · jobId, confirmDomain |
| 成功响应 | 202 · { jobId, status } |

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/admin/domains/example.com/cleanup" \
  --header "Authorization: Bearer om_at_owner..." \
  --header "Content-Type: application/json" \
  --data '{
  "jobId": "00000000-0000-4000-8000-000000000000",
  "confirmDomain": "example.com"
}'
```

<!-- endpoint:GET /api/admin/domain-cleanup-jobs/:id catalog:9f4db47b3acf -->
## `GET /api/admin/domain-cleanup-jobs/{id}`

**读取清理进度 / Read cleanup progress**

查询持久化任务的汇总进度、未完成对象数和脱敏错误提示。

> Read persisted task progress, pending object counts and sanitized errors.

| 项目 | 内容 |
| --- | --- |
| 认证 | 仅主管理员 |
| 请求 | Path · id |
| 成功响应 | 200 · { job } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/admin/domain-cleanup-jobs/resource_id" \
  --header "Authorization: Bearer om_at_owner..."
```

<!-- endpoint:POST /api/admin/domain-cleanup-jobs/:id/retry catalog:e5a8c36e9679 -->
## `POST /api/admin/domain-cleanup-jobs/{id}/retry`

**重试清理任务 / Retry cleanup task**

继续同一任务尚未完成的目标与对象；已删除的数据不会恢复。

> Continue unfinished targets and objects of the same task. Deleted data cannot be restored.

| 项目 | 内容 |
| --- | --- |
| 认证 | 仅主管理员 |
| 请求 | Path · id |
| 成功响应 | 202 · { jobId, status } |

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/admin/domain-cleanup-jobs/resource_id/retry" \
  --header "Authorization: Bearer om_at_owner..."
```
