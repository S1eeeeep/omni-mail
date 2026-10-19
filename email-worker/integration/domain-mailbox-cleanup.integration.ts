import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Env, SessionUser } from '../src/app/types'
import { deleteDomain, updateDomain } from '../src/features/admin/domains/domain-api'
import { domainMailboxes } from '../src/features/admin/domains/domain-mailbox-api'
import { domainCleanupStatus, previewDomainCleanup, retryDomainCleanup, submitDomainCleanup } from '../src/features/admin/domains/domain-cleanup-api'
import { cleanupJob, recoverDomainCleanupDispatch } from '../src/features/admin/domains/domain-cleanup-store'
import { runDomainCleanupBatch } from '../src/features/admin/domains/domain-cleanup-runner'
import { listMailboxes } from '../src/features/mailboxes/mailbox-api'
import { parseMessage } from '../src/app/handlers/mail'
import { deliverOutboundMessage } from '../src/features/outbound/outbound-message'

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS) })

const post = (body: unknown) => new Request('https://mail.example.com/api', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

async function fixture() {
  const id = crypto.randomUUID()
  const domain = `d-${id.slice(0, 8)}.test`
  const user = { id, email: `owner@${domain}`, role: 'super_admin' } as SessionUser
  const otherId = crypto.randomUUID()
  const address = `a@${domain}`
  const otherAddress = `b@${domain}`
  const create = vi.fn(async () => ({ id: 'workflow' }))
  const environment = { ...env, CLEANUP_WORKFLOW: { create, get: vi.fn(() => ({ status: async () => { throw new Error('not found') } })) } } as unknown as Env
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, display_name, password_hash, role, storage_used_bytes) VALUES (?, ?, 'Owner', 'test', 'super_admin', 107)`).bind(id, user.email),
    env.DB.prepare(`INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, 'Other', 'test')`).bind(otherId, `person@${domain}`),
    env.DB.prepare('INSERT INTO domains (name) VALUES (?)').bind(domain),
    env.DB.prepare('INSERT INTO mailboxes (address, user_id) VALUES (?, ?)').bind(address, id),
    env.DB.prepare('INSERT INTO mailboxes (address, user_id) VALUES (?, ?)').bind(otherAddress, otherId),
    env.DB.prepare(`INSERT INTO temporary_invites (id, token_hash, domain_name, expires_at, created_by) VALUES (?, ?, ?, unixepoch() + 600, ?)`).bind(id, id, domain, id),
    env.DB.prepare(`INSERT INTO messages (id, mailbox_address, direction, status, folder, sender_address, quota_bytes, raw_key, body_key)
      VALUES (?, ?, 'incoming', 'ready', 'inbox', 'sender@example.net', 100, ?, ?)`).bind(id, address, `raw/${id}`, `body/${id}`),
    env.DB.prepare(`INSERT INTO attachments (id, message_id, filename, content_type, size, r2_key) VALUES (?, ?, 'test.txt', 'text/plain', 5, ?)`).bind(id, id, `attachment/${id}`),
    env.DB.prepare(`INSERT INTO message_translations (message_id, target_language, source_language, source_hash, model, r2_key) VALUES (?, 'zh', 'en', 'test', 'test', ?)`).bind(id, `translation/${id}`),
    env.DB.prepare('INSERT INTO mail_drafts (id, user_id, mailbox_address, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').bind(id, id, address),
    env.DB.prepare(`INSERT INTO mail_draft_attachments (id, draft_id, filename, content_type, size, r2_key, created_at) VALUES (?, ?, 'draft.txt', 'text/plain', 7, ?, 1)`).bind(id, id, `draft/${id}`),
  ])
  const keys = ['raw', 'body', 'attachment', 'translation', 'draft'].map((prefix) => `${prefix}/${id}`)
  for (const key of keys) await env.MAIL_BUCKET.put(key, 'fixture')
  const preview = async (mode: string = 'all_and_remove', addresses: string[] = []) => {
    const response = await previewDomainCleanup(environment, user, domain, post({ mode, addresses }))
    expect(response.status).toBe(200)
    return response.json<{ jobId: string; summary: { mailboxCount: number; messageCount: number; bytes: number } }>()
  }
  const submit = (jobId: string, target = environment) => submitDomainCleanup(target, user, domain, post({ jobId, confirmDomain: domain }), '127.0.0.1')
  return { id, domain, user, otherId, address, otherAddress, environment, create, keys, preview, submit }
}

async function finish(environment: Env, jobId: string, attempt = 0) {
  for (let index = 0; index < 20; index++) if (await runDomainCleanupBatch(environment, jobId, attempt)) return
  throw new Error('cleanup did not finish')
}

describe('域名与关联邮箱管理', () => {
  it('显式移除配置保留邮箱、邮件、草稿与对象，旧接口继续拒绝非空域名', async () => {
    const f = await fixture()
    expect((await deleteDomain(f.environment, f.user, f.domain, 'ip')).status).toBe(409)
    expect((await deleteDomain(f.environment, f.user, f.domain, 'ip', 'configuration')).status).toBe(200)
    expect(await env.DB.prepare('SELECT name FROM domains WHERE name = ?').bind(f.domain).first()).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM temporary_invites WHERE id = ?').bind(f.id).first()).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM messages WHERE id = ?').bind(f.id).first()).not.toBeNull()
    expect(await env.DB.prepare('SELECT id FROM mail_drafts WHERE id = ?').bind(f.id).first()).not.toBeNull()
    const list = await listMailboxes(f.environment, f.user)
    expect(await list.json()).toMatchObject({ mailboxes: [{ address: f.address, domainActive: false }] })
    for (const key of f.keys) expect(await env.MAIL_BUCKET.head(key)).not.toBeNull()
  })

  it('关联查询覆盖其他用户和隐藏记录，分页与精确域名隔离有效', async () => {
    const f = await fixture()
    await env.DB.batch([
      env.DB.prepare('INSERT INTO mailboxes (address, user_id, is_primary) VALUES (?, ?, 1)').bind(`p@${f.domain}`, f.id),
      env.DB.prepare('INSERT INTO mailboxes (address, user_id, is_hidden) VALUES (?, ?, 1)').bind(`z@${f.domain}`, f.id),
      env.DB.prepare('INSERT INTO mailboxes (address, user_id) VALUES (?, ?)').bind(`a@sub.${f.domain}`, f.id),
    ])
    const first = await domainMailboxes(f.environment, f.user, f.domain, new Request('https://mail.example/api?limit=1'))
    const data = await first.json<{ mailboxes: Array<{ address: string }>; page: { nextCursor: string }; totals: { total: number } }>()
    expect(data).toMatchObject({ mailboxes: [{ address: f.address }], totals: { total: 4, primaryCount: 1, cleaningCount: 1 } })
    const second = await domainMailboxes(f.environment, f.user, f.domain, new Request(`https://mail.example/api?limit=1&cursor=${data.page.nextCursor}`))
    expect(await second.json()).toMatchObject({ mailboxes: [{ address: f.otherAddress, userId: f.otherId }] })
    expect((await domainMailboxes(f.environment, { ...f.user, role: 'user' }, f.domain, new Request('https://mail.example/api'))).status).toBe(403)
  })

  it('权限和外部输入在服务端校验', async () => {
    const f = await fixture()
    expect((await previewDomainCleanup(f.environment, { ...f.user, role: 'admin' }, f.domain, post({ mode: 'all_and_remove' }))).status).toBe(403)
    for (const body of [null, [], { mode: 'other' }, { mode: { toString: 'selected' } }, { mode: 'selected', addresses: [1] }, { mode: 'selected', addresses: [`a@sub.${f.domain}`] }]) {
      expect((await previewDomainCleanup(f.environment, f.user, f.domain, post(body))).status).toBe(400)
    }
    expect((await deleteDomain(f.environment, f.user, f.domain, 'ip', 'cascade')).status).toBe(400)
    expect((await domainMailboxes(f.environment, f.user, '%invalid', new Request('https://mail.example/api'))).status).toBe(400)
    expect((await domainMailboxes(f.environment, f.user, f.domain, new Request('https://mail.example/api?limit=101'))).status).toBe(400)
  })

  it.each(['primary', 'owner', 'new_mailbox', 'expired'])('预览后的 %s 变化使提交失败，并回滚域名冻结', async (change) => {
    const f = await fixture()
    const preview = await f.preview()
    if (change === 'primary') await env.DB.prepare('UPDATE mailboxes SET is_primary = 1 WHERE address = ?').bind(f.address).run()
    if (change === 'owner') await env.DB.prepare('UPDATE mailboxes SET user_id = ? WHERE address = ?').bind(f.otherId, f.address).run()
    if (change === 'new_mailbox') await env.DB.prepare('INSERT INTO mailboxes (address, user_id) VALUES (?, ?)').bind(`new@${f.domain}`, f.id).run()
    if (change === 'expired') await env.DB.prepare('UPDATE domain_cleanup_jobs SET expires_at = 0 WHERE id = ?').bind(preview.jobId).run()
    expect((await f.submit(preview.jobId)).status).toBe(409)
    expect(await env.DB.prepare('SELECT is_active FROM domains WHERE name = ?').bind(f.domain).first()).toEqual({ is_active: 1 })
    expect(f.create).not.toHaveBeenCalled()
  })

  it('过期预览被调度并发清除时，提交不会冻结域名或留下审计误报', async () => {
    const f = await fixture()
    const preview = await f.preview()
    await env.DB.prepare('UPDATE domain_cleanup_jobs SET expires_at = 0 WHERE id = ?').bind(preview.jobId).run()
    const environment = { ...f.environment, DB: {
      prepare: (sql: string) => env.DB.prepare(sql),
      async batch(statements: D1PreparedStatement[]) {
        await env.DB.prepare(`DELETE FROM domain_cleanup_jobs WHERE id = ? AND status = 'preview' AND expires_at < unixepoch()`)
          .bind(preview.jobId).run()
        return env.DB.batch(statements)
      },
    } } as unknown as Env
    expect((await f.submit(preview.jobId, environment)).status).toBe(409)
    expect(await env.DB.prepare('SELECT is_active FROM domains WHERE name = ?').bind(f.domain).first()).toEqual({ is_active: 1 })
    expect(await env.DB.prepare(`SELECT 1 FROM audit_logs WHERE target_id = ? AND action = 'domain.cleanup_scheduled'`).bind(f.domain).first()).toBeNull()
    expect(f.create).not.toHaveBeenCalled()
  })

  it('主邮箱和已有个人删除记录阻止全域清理，选中清理不扩大目标', async () => {
    const f = await fixture()
    await env.DB.prepare('UPDATE mailboxes SET is_primary = 1 WHERE address = ?').bind(f.otherAddress).run()
    expect((await previewDomainCleanup(f.environment, f.user, f.domain, post({ mode: 'all_and_remove' }))).status).toBe(409)
    const preview = await f.preview('selected', [f.address])
    expect((await f.submit(preview.jobId)).status).toBe(202)
    await finish(f.environment, preview.jobId)
    expect(await env.DB.prepare('SELECT address FROM mailboxes WHERE address = ?').bind(f.otherAddress).first()).not.toBeNull()
    expect(await env.DB.prepare('SELECT is_active FROM domains WHERE name = ?').bind(f.domain).first()).toEqual({ is_active: 1 })
  })

  it('任务冻结目标写入和配置操作，重复请求绑定同一 Workflow 实例', async () => {
    const f = await fixture()
    const preview = await f.preview()
    expect((await f.submit(preview.jobId)).status).toBe(202)
    expect((await f.submit(preview.jobId)).status).toBe(202)
    expect(new Set(f.create.mock.calls.map((call) => (call as unknown as [{ id: string }])[0].id)).size).toBe(1)
    for (const sql of [
      'UPDATE mailboxes SET is_primary = 1 WHERE address = ?',
      'UPDATE mailboxes SET is_hidden = 0, is_active = 1 WHERE address = ?',
      `INSERT INTO messages (id, mailbox_address, direction, status, folder, sender_address) VALUES ('late', ?, 'incoming', 'processing', 'inbox', 'sender@example.net')`,
      `UPDATE mailboxes SET user_id = 'someone' WHERE address = ?`,
    ]) await expect(env.DB.prepare(sql).bind(f.address).run()).rejects.toThrow()
    await expect(env.DB.prepare('INSERT INTO mailboxes (address, user_id) VALUES (?, ?)').bind(`new@${f.domain}`, f.id).run()).rejects.toThrow()
    await expect(env.DB.prepare('DELETE FROM users WHERE id = ?').bind(f.id).run()).rejects.toThrow()
    expect((await deleteDomain(f.environment, f.user, f.domain, 'ip', 'configuration')).status).toBe(409)
    expect((await updateDomain(f.environment, f.user, f.domain, post({ isActive: true }), 'ip')).status).toBe(409)
  })

  it('清理期间已排队的解析和发件任务不再读取或写入对象', async () => {
    const f = await fixture()
    await env.DB.prepare(`UPDATE messages SET status = 'processing', direction = 'outgoing' WHERE id = ?`).bind(f.id).run()
    const preview = await f.preview()
    await f.submit(preview.jobId)
    const bucket = { get: vi.fn(), put: vi.fn() }
    const environment = { ...f.environment, MAIL_BUCKET: bucket } as unknown as Env
    await parseMessage({ messageId: f.id }, environment)
    await deliverOutboundMessage(environment, { messageId: f.id } as Parameters<typeof deliverOutboundMessage>[1])
    expect(bucket.get).not.toHaveBeenCalled()
    expect(bucket.put).not.toHaveBeenCalled()
  })

  it('已有 Workflow 终态失败不会让持久化任务永久卡在待派发', async () => {
    const f = await fixture()
    const preview = await f.preview()
    f.create.mockRejectedValueOnce(new Error('instance already exists'))
    const environment = { ...f.environment, CLEANUP_WORKFLOW: { create: f.create, get: () => ({ status: async () => ({ status: 'errored' }) }) } } as unknown as Env
    await f.submit(preview.jobId, environment)
    expect((await cleanupJob(f.environment, preview.jobId))?.status).toBe('failed')
    await retryDomainCleanup(f.environment, f.user, preview.jobId, 'ip')
    expect((await cleanupJob(f.environment, preview.jobId))?.attempt).toBe(1)
  })

  it('派发失败保留可恢复任务，错误确认和其他操作者不能启动预览', async () => {
    const f = await fixture()
    const preview = await f.preview()
    expect((await submitDomainCleanup(f.environment, f.user, f.domain, post({ jobId: preview.jobId, confirmDomain: 'other.test' }), 'ip')).status).toBe(400)
    expect((await submitDomainCleanup(f.environment, { ...f.user, id: f.otherId }, f.domain, post({ jobId: preview.jobId, confirmDomain: f.domain }), 'ip')).status).toBe(404)
    f.create.mockRejectedValueOnce(new Error('temporary dispatch failure'))
    expect((await f.submit(preview.jobId)).status).toBe(202)
    expect((await cleanupJob(f.environment, preview.jobId))?.status).toBe('pending')
    await recoverDomainCleanupDispatch(f.environment)
    expect(f.create.mock.calls.filter((call) => (call as unknown as [{ id: string }])[0].id.includes(preview.jobId))).toHaveLength(2)
  })

  it('全域清理删除所有目标对象且只扣一次配额，旧任务重放不影响重新分配的地址', async () => {
    const f = await fixture()
    const preview = await f.preview()
    expect(preview.summary).toMatchObject({ mailboxCount: 2, messageCount: 1, bytes: 107 })
    await f.submit(preview.jobId)
    await finish(f.environment, preview.jobId)
    expect((await cleanupJob(f.environment, preview.jobId))?.status).toBe('completed')
    expect(await env.DB.prepare('SELECT storage_used_bytes FROM users WHERE id = ?').bind(f.id).first()).toEqual({ storage_used_bytes: 0 })
    expect(await env.DB.prepare('SELECT name FROM domains WHERE name = ?').bind(f.domain).first()).toBeNull()
    for (const key of f.keys) expect(await env.MAIL_BUCKET.head(key)).toBeNull()
    await env.DB.batch([
      env.DB.prepare('INSERT INTO domains (name) VALUES (?)').bind(f.domain),
      env.DB.prepare('INSERT INTO mailboxes (address, user_id) VALUES (?, ?)').bind(f.address, f.id),
    ])
    await finish(f.environment, preview.jobId)
    expect(await env.DB.prepare('SELECT address FROM mailboxes WHERE address = ?').bind(f.address).first()).not.toBeNull()
  })

  it('R2 失败不会宣称完成；任务重试仅清理剩余对象', async () => {
    const f = await fixture()
    const preview = await f.preview()
    await f.submit(preview.jobId)
    const broken = { ...f.environment, MAIL_BUCKET: { delete: async () => { throw new Error('storage failure') } } } as unknown as Env
    await runDomainCleanupBatch(broken, preview.jobId, 0)
    await runDomainCleanupBatch(broken, preview.jobId, 0)
    await expect(runDomainCleanupBatch(broken, preview.jobId, 0)).rejects.toThrow('cleanup_objects_pending')
    const status = await domainCleanupStatus(f.environment, f.user, preview.jobId)
    expect(await status.json()).toMatchObject({ job: { status: 'waiting_for_objects', objectsPending: 5 } })
    await env.DB.prepare(`UPDATE domain_cleanup_jobs SET status = 'failed' WHERE id = ?`).bind(preview.jobId).run()
    expect((await retryDomainCleanup(f.environment, f.user, preview.jobId, 'ip')).status).toBe(202)
    await finish(f.environment, preview.jobId, 1)
    expect((await cleanupJob(f.environment, preview.jobId))?.status).toBe('completed')
    expect(await env.DB.prepare('SELECT storage_used_bytes FROM users WHERE id = ?').bind(f.id).first()).toEqual({ storage_used_bytes: 0 })
  })
})
