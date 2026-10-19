import type { Env } from '../../../app/types'
import { decryptMailCredential, encryptMailCredential, globalMailKeyId, legacyMailCredentialsReady } from '../../../shared/security/mail-credentials'
import { mailCredentialFields } from './mail-credential-fields'

export interface MigrationCursor { field: number; afterId: string }
export const MIGRATION_BATCH_SIZE = 10

export async function mailCredentialMigrationStatus(env: Env) {
  const keyId = await globalMailKeyId(env)
  // D1 限制复合 SELECT 的项数；用同一批次读取全部字段，避免拼接过大的 UNION。
  const counts = await env.DB.batch<{ field: number; total: number; migrated: number }>(mailCredentialFields.map((field, index) => env.DB.prepare(
    `SELECT ${index} AS field, COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN ${field.column} LIKE ? THEN 1 ELSE 0 END), 0) AS migrated
       FROM ${field.table} WHERE ${field.column} <> ''`
  ).bind(keyId ? `v2.${keyId}.%` : 'unconfigured.%')))
  const providers = new Map<string, { provider: string; total: number; migrated: number; pending: number; legacyKeyReady: boolean }>()
  for (const row of counts.flatMap((result) => result.results)) {
    const field = mailCredentialFields[row.field]
    const item = providers.get(field.provider) || {
      provider: field.provider, total: 0, migrated: 0, pending: 0,
      legacyKeyReady: legacyMailCredentialsReady(env, field.key),
    }
    item.total += row.total
    item.migrated += row.migrated
    item.pending += row.total - row.migrated
    providers.set(field.provider, item)
  }
  const list = [...providers.values()]
  const total = list.reduce((sum, item) => sum + item.total, 0)
  const migrated = list.reduce((sum, item) => sum + item.migrated, 0)
  return {
    globalKeyConfigured: Boolean(env.MAIL_CREDENTIALS_KEY?.trim()),
    globalKeyReady: keyId !== null, keyId, total, migrated, pending: total - migrated,
    providers: list,
  }
}

export function parseMigrationRequest(value: unknown): { keyId: string; cursor: MigrationCursor } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (body.confirm !== true || typeof body.keyId !== 'string' || !/^[a-f0-9]{32}$/.test(body.keyId)
    || Object.keys(body).some((key) => !['confirm', 'keyId', 'cursor'].includes(key))) return null
  if (body.cursor === undefined || body.cursor === null) return { keyId: body.keyId, cursor: { field: 0, afterId: '' } }
  if (typeof body.cursor !== 'object' || Array.isArray(body.cursor)) return null
  const cursor = body.cursor as Record<string, unknown>
  if (typeof cursor.field !== 'number' || !Number.isInteger(cursor.field)
    || cursor.field < 0 || cursor.field >= mailCredentialFields.length
    || typeof cursor.afterId !== 'string' || cursor.afterId.length > 254 || /[\x00-\x1f]/.test(cursor.afterId)
    || Object.keys(cursor).some((key) => !['field', 'afterId'].includes(key))) return null
  return { keyId: body.keyId, cursor: { field: cursor.field, afterId: cursor.afterId } }
}

export async function migrateMailCredentialBatch(env: Env, keyId: string, initial: MigrationCursor) {
  if (await globalMailKeyId(env) !== keyId) throw new Error('MAIL_KEY_CHANGED')
  let fieldIndex = initial.field
  let afterId = initial.afterId
  let scanned = 0
  let migrated = 0
  let failed = 0
  let conflicts = 0
  while (fieldIndex < mailCredentialFields.length && scanned < MIGRATION_BATCH_SIZE) {
    const field = mailCredentialFields[fieldIndex]
    const limit = MIGRATION_BATCH_SIZE - scanned
    const { results } = await env.DB.prepare(
      `SELECT id, user_id, ${field.column} AS cipher FROM ${field.table}
        WHERE id > ? AND ${field.column} <> '' AND ${field.column} NOT LIKE ? ORDER BY id LIMIT ?`,
    ).bind(afterId, `v2.${keyId}.%`, limit).all<{ id: string; user_id: string; cipher: string }>()
    for (const row of results) {
      scanned++
      afterId = row.id
      let encrypted: string
      try {
        const context = `${row.user_id}:${row.id}:${field.purpose}`
        const plaintext = await decryptMailCredential(env, field.key, row.cipher, context)
        encrypted = await encryptMailCredential(env, field.key, plaintext, context)
      } catch {
        // 损坏或缺少旧密钥的记录保留原样；继续扫描，不能让一条坏记录挡住其他账号。
        failed++
        continue
      }
      // 只替换仍与读取时一致的密文，不改账号状态、时间戳或同步租约。
      const result = await env.DB.prepare(
        `UPDATE ${field.table} SET ${field.column} = ? WHERE id = ? AND user_id = ? AND ${field.column} = ?`,
      ).bind(encrypted, row.id, row.user_id, row.cipher).run()
      if (result.meta.changes) migrated++
      else conflicts++
    }
    if (results.length < limit) { fieldIndex++; afterId = '' }
  }
  return {
    cursor: fieldIndex < mailCredentialFields.length ? { field: fieldIndex, afterId } : null,
    scanned, migrated, failed, conflicts,
  }
}
