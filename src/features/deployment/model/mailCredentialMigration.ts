import { request } from '../../../shared/api/api-client'

export interface MailCredentialMigrationStatus {
  globalKeyConfigured: boolean
  globalKeyReady: boolean
  keyId: string | null
  total: number
  migrated: number
  pending: number
  providers: Array<{ provider: string; total: number; migrated: number; pending: number; legacyKeyReady: boolean }>
}

export interface MigrationCursor { field: number; afterId: string }
export interface MailCredentialMigrationBatch {
  cursor: MigrationCursor | null
  scanned: number
  migrated: number
  failed: number
  conflicts: number
  status: MailCredentialMigrationStatus
}

export function validMigrationStatus(value: unknown): value is MailCredentialMigrationStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value as MailCredentialMigrationStatus
  const count = (number: unknown) => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0
  if (typeof status.globalKeyConfigured !== 'boolean' || typeof status.globalKeyReady !== 'boolean'
    || !(status.keyId === null || (typeof status.keyId === 'string' && /^[a-f0-9]{32}$/.test(status.keyId)))
    || (status.globalKeyReady && status.keyId === null)
    || ![status.total, status.migrated, status.pending].every(count)
    || status.total !== status.migrated + status.pending
    || !Array.isArray(status.providers) || status.providers.length > 7) return false
  return status.providers.every((provider) => provider && typeof provider === 'object'
    && typeof provider.provider === 'string' && provider.provider.length > 0 && provider.provider.length <= 64
    && [provider.total, provider.migrated, provider.pending].every(count)
    && provider.total === provider.migrated + provider.pending && typeof provider.legacyKeyReady === 'boolean')
}

function checkedStatus(value: unknown): MailCredentialMigrationStatus {
  if (!validMigrationStatus(value)) throw new Error('无法读取邮箱密钥迁移状态。')
  return value
}

export const mailCredentialMigration = {
  status: async () => checkedStatus(await request<unknown>('/api/admin/mail-credentials/migration')),
  batch: async (keyId: string, cursor: MigrationCursor | null) => {
    const batch = await request<MailCredentialMigrationBatch>(
      '/api/admin/mail-credentials/migration', {
        method: 'POST', body: JSON.stringify({ confirm: true, keyId, cursor }), timeoutMs: 30_000,
      },
    )
    checkedStatus(batch?.status)
    return batch
  },
}
