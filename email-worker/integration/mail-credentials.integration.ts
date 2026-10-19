import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Env as OmniMailEnv, SessionUser } from '../src/app/types'
import { mailCredentialFields } from '../src/features/admin/credentials/mail-credential-fields'
import { mailCredentialMigrationStatus, migrateMailCredentialBatch, type MigrationCursor } from '../src/features/admin/credentials/mail-credential-migration'
import { getMailCredentialMigration, postMailCredentialMigration } from '../src/features/admin/credentials/mail-credential-api'
import { decryptMailCredential, encryptMailCredential, globalMailKeyId } from '../src/shared/security/mail-credentials'

declare global {
  namespace Cloudflare {
    interface Env extends OmniMailEnv { TEST_MIGRATIONS: Array<{ name: string; queries: string[] }> }
  }
}

const legacy = Object.fromEntries(mailCredentialFields.map((field) => [field.key, `test-legacy-key-for-${field.key}-long-enough`])) as unknown as OmniMailEnv
const global = { MAIL_CREDENTIALS_KEY: 'test-global-credential-key-with-at-least-32-bytes' }
const owner = { id: 'migration-owner', role: 'super_admin' } as SessionUser
const mixed = () => ({ ...env, ...legacy, ...global })

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS) })
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM users WHERE id = 'migration-owner'").run()
  await env.DB.prepare(`INSERT INTO users (id, email, display_name, password_hash, role)
    VALUES ('migration-owner', 'migration-owner@example.com', 'Owner', 'test', 'super_admin')`).run()
  const tables = [...new Set(mailCredentialFields.map((field) => field.table))]
  for (const table of tables) {
    const fields = mailCredentialFields.filter((field) => field.table === table)
    const rows = table === 'microsoft_imap_accounts'
      ? [fields.filter((field) => field.purpose !== 'password'), fields.filter((field) => field.purpose === 'password')]
      : [fields]
    for (const [index, columns] of rows.entries()) {
      const id = `${table}-${index}`
      const row: Record<string, string | number> = { id, user_id: owner.id, created_at: 1, updated_at: 1 }
      if (table === 'linux_do_mail_accounts') row.username = 'test@linux.do'
      else row.name = 'Account'
      if (table === 'microsoft_imap_accounts') {
        Object.assign(row, { provided_email: `${index}@outlook.com`, normalized_email: `${index}@outlook.com`,
          auth_mode: index === 0 ? 'oauth2' : 'password', client_id: index === 0 ? 'test-client' : '' })
      } else if (!['icloud_accounts', 'linux_do_mail_accounts'].includes(table)) row.email = `${table}@example.com`
      if (table === 'naver_mail_accounts') row.naver_id = 'test'
      if (table === 'yandex_mail_accounts') row.yandex_login = 'test'
      for (const field of columns) {
        row[field.column] = await encryptMailCredential(legacy, field.key, `test-value-${field.purpose}`, `${owner.id}:${id}:${field.purpose}`)
      }
      await env.DB.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`)
        .bind(...Object.values(row)).run()
    }
  }
})

describe('真实 D1 邮箱密钥迁移', () => {
  it('读取进度不会写入；分页处理全部 11 个字段，重试幂等且删除旧密钥后可解密', async () => {
    const environment = mixed()
    const before = await mailCredentialMigrationStatus(environment)
    expect(before).toMatchObject({ total: 11, migrated: 0, pending: 11 })
    expect(await mailCredentialMigrationStatus(environment)).toEqual(before)
    const keyId = (await globalMailKeyId(environment))!
    let cursor: MigrationCursor | null = { field: 0, afterId: '' }
    do {
      const batch = await migrateMailCredentialBatch(environment, keyId, cursor)
      expect(batch.scanned).toBeLessThanOrEqual(10)
      expect(batch.failed).toBe(0)
      cursor = batch.cursor
    } while (cursor)
    expect(await mailCredentialMigrationStatus(environment)).toMatchObject({ total: 11, migrated: 11, pending: 0 })
    expect((await migrateMailCredentialBatch(environment, keyId, { field: 0, afterId: '' })).scanned).toBe(0)
    for (const field of mailCredentialFields) {
      const { results } = await env.DB.prepare(`SELECT id, ${field.column} AS cipher, updated_at FROM ${field.table} WHERE ${field.column} <> ''`)
        .all<{ id: string; cipher: string; updated_at: number | string }>()
      for (const row of results) {
        expect(Number(row.updated_at)).toBe(1)
        await expect(decryptMailCredential(global as OmniMailEnv, field.key, row.cipher, `${owner.id}:${row.id}:${field.purpose}`))
          .resolves.toBe(`test-value-${field.purpose}`)
      }
    }
  })

  it('坏密文不会阻塞后续服务，也不会被覆盖或误报完成', async () => {
    await env.DB.prepare("UPDATE gmail_imap_accounts SET app_password_cipher = 'invalid-cipher'").run()
    const environment = mixed()
    const keyId = (await globalMailKeyId(environment))!
    let cursor: MigrationCursor | null = { field: 0, afterId: '' }
    let failed = 0
    do {
      const batch = await migrateMailCredentialBatch(environment, keyId, cursor)
      failed += batch.failed
      cursor = batch.cursor
    } while (cursor)
    expect(failed).toBe(1)
    expect(await mailCredentialMigrationStatus(environment)).toMatchObject({ migrated: 10, pending: 1 })
    expect(await env.DB.prepare('SELECT app_password_cipher AS cipher FROM gmail_imap_accounts').first())
      .toEqual({ cipher: 'invalid-cipher' })
  })

  it('迁移与密码更新并发时不会覆盖新凭据', async () => {
    const environment = mixed()
    const keyId = (await globalMailKeyId(environment))!
    const id = 'gmail_imap_accounts-0'
    const cipher = await encryptMailCredential(environment, 'GMAIL_CREDENTIALS_KEY', 'concurrent-password', `${owner.id}:${id}:app-password`)
    let changed = false
    const db = {
      prepare(sql: string) {
        const statement = env.DB.prepare(sql)
        if (!sql.startsWith('UPDATE gmail_imap_accounts')) return statement
        return { bind(...values: unknown[]) {
          const bound = statement.bind(...values)
          return { async run() {
            changed = true
            await env.DB.prepare('UPDATE gmail_imap_accounts SET app_password_cipher = ? WHERE id = ?').bind(cipher, id).run()
            return bound.run()
          } }
        } }
      },
    } as unknown as D1Database
    const batch = await migrateMailCredentialBatch({ ...environment, DB: db }, keyId, { field: 3, afterId: '' })
    expect(changed).toBe(true)
    expect(batch.conflicts).toBe(1)
    expect(await env.DB.prepare('SELECT app_password_cipher AS cipher FROM gmail_imap_accounts').first()).toEqual({ cipher })
  })

  it('缺少旧密钥保留数据；接口只返回进度并记录无敏感值的审计', async () => {
    const environment = { ...mixed(), GMAIL_CREDENTIALS_KEY: undefined }
    const statusResponse = await getMailCredentialMigration(environment, owner, 'cookie')
    expect(statusResponse.status).toBe(200)
    const text = await statusResponse.text()
    expect(text).not.toContain(global.MAIL_CREDENTIALS_KEY)
    expect(text).not.toContain('test-value-')
    const keyId = (await globalMailKeyId(environment))!
    const response = await postMailCredentialMigration(environment, owner, new Request('https://mail.example.com/api/admin/mail-credentials/migration', {
      method: 'POST', body: JSON.stringify({ confirm: true, keyId, cursor: { field: 3, afterId: '' } }),
    }), 'cookie', '127.0.0.1')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ failed: 1 })
    const logs = await env.DB.prepare("SELECT detail_json FROM audit_logs WHERE action = 'system.mail_credentials_migrated'").all()
    expect(logs.results.length).toBeGreaterThan(0)
    expect(JSON.stringify(logs)).not.toContain('test-value-')
    expect(JSON.stringify(logs)).not.toContain('v1.')
  })
})
