import { localized as l, type ApiEndpoint } from './apiCatalogTypes'

export const credentialMigrationEndpoints: ApiEndpoint[] = [
  {
    method: 'GET', path: '/api/admin/mail-credentials/migration', group: 'adminSettings', auth: 'cookie',
    title: l('读取邮箱密钥迁移进度', 'Read mail key migration progress'),
    description: l('仅主管理员 Cookie 会话；只统计配置和迁移进度，不返回密钥、凭据或密文。', 'Owner cookie session only; return configuration and progress without keys, credentials or ciphertext.'),
    request: 'No parameters', response: '200 · { globalKeyConfigured, globalKeyReady, keyId, total, migrated, pending, providers }',
  },
  {
    method: 'POST', path: '/api/admin/mail-credentials/migration', group: 'adminSettings', auth: 'cookie',
    title: l('迁移一批邮箱凭据', 'Migrate one batch of mail credentials'),
    description: l('仅主管理员 Cookie 会话；每次最多处理 10 个凭据字段。必须显式确认并提交当前 keyId；失败保留原数据，关闭页面后不再发起后续批次。', 'Owner cookie session only; process at most 10 credential fields per request. Requires explicit confirmation and the current keyId. Failures preserve the original data; closing the page stops further batches.'),
    request: 'JSON · confirm: true, keyId, cursor?: { field, afterId } | null',
    response: '200 · { cursor, scanned, migrated, failed, conflicts, status }',
    exampleBody: { confirm: true, keyId: '0123456789abcdef0123456789abcdef', cursor: null },
  },
]
