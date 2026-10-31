import { localized as l, type ApiEndpoint } from './apiCatalogTypes'

export const mailPushEndpoints: ApiEndpoint[] = [
  { method: 'GET', path: '/api/integrations/mail-push', group: 'messages', auth: 'authenticated',
    title: l('读取推送通道状态', 'Read mail push delivery status'),
    description: l('读取当前用户的队列绑定、主邮箱进度、待投递量和错误分类，不返回密钥或邮件内容。', 'Return queue availability, mailbox progress, backlog counts and error codes without keys or mail content.'),
    request: 'No parameters', response: '200 · { queue_configured, now, routes }' },
  { method: 'POST', path: '/api/integrations/mail-push/retry', group: 'messages', auth: 'authenticated',
    title: l('重试失败推送', 'Retry failed mail delivery'),
    description: l('重新排队当前用户的失败推送，保留原事件身份和内容，不重新发送邮件。', 'Requeue failed deliveries for the current user while retaining original event identity and content.'),
    request: 'No parameters', response: '200 · { status: queued }' },
  { method: 'PUT', path: '/api/integrations/mail-push', group: 'messages', auth: 'authenticated',
    title: l('配置邮件推送', 'Configure mail push'),
    description: l('使用完整设备权限，为当前用户明确拥有的主邮箱配置持久推送；签名密钥加密保存。首次订阅补投最近24小时，后续直接推送正文并在失败后重试。', 'Requires full device scope and explicitly owned mailboxes. Encrypts the signing key, replays the last 24 hours on initial setup, and retries durable body delivery.'),
    request: 'JSON · id: UUID, secret: 43-character base64url key, callback_url: HTTPS receiver URL, mailboxes: string[]',
    response: '200 · { status, subscription_id, mailboxes }',
    exampleBody: { id: '12556f6a-15f0-4d91-af71-67ec23d7ce47', secret: 'REPLACE_WITH_A_32_BYTE_BASE64URL_SIGNING_KEY', callback_url: 'https://pickup.example.com/api/integrations/omnimail/events', mailboxes: ['owner@example.com'] },
  },
]
