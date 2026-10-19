import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { listMessages } from '../src/features/messages/message-list-api'
import { updateMessage } from '../src/features/messages/message-detail-api'
import { bulkUpdateMessages } from '../src/features/messages/message-bulk-api'
import type { Env as OmniMailEnv, SessionUser } from '../src/app/types'

declare global {
  namespace Cloudflare {
    interface Env extends OmniMailEnv { TEST_MIGRATIONS: Array<{ name: string; queries: string[] }> }
  }
}

const owner = { id: 'read-owner', role: 'super_admin' } as SessionUser
const address = 'target@example.com'
type ListResult = { version: number; unchanged: boolean; messages: Array<{ id: string; isRead: boolean }>; counts: { unread: number; drafts: number }; page: { nextCursor: string | null; hasMore: boolean } }
type Measurement = { read: number; written: number }

function measured() {
  const operations: Measurement[] = []
  let beforeBatch: (() => Promise<void>) | undefined
  const db = {
    prepare: (sql: string) => env.DB.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      if (beforeBatch) { const run = beforeBatch; beforeBatch = undefined; await run() }
      const results = await env.DB.batch(statements)
      results.forEach((result) => operations.push({
        read: result.meta.rows_read, written: result.meta.rows_written,
      }))
      return results
    },
  } as unknown as D1Database
  return { environment: { ...env, DB: db }, operations, beforeBatch: (callback: () => Promise<void>) => { beforeBatch = callback } }
}

async function list(environment: OmniMailEnv, query = `mailbox=${address}`, user = owner) {
  const response = await listMessages(environment, user, new Request(`https://mail.example.com/api/messages?${query}`))
  expect(response.status).toBe(200)
  return response.json() as Promise<ListResult>
}

let baseline: ListResult
let baselineRows = 0
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) < 36))
  for (const id of ['read-owner', 'read-other']) {
    await env.DB.prepare('INSERT INTO users (id,email,display_name,password_hash) VALUES (?,?,?,?)')
      .bind(id, `${id}@example.com`, id, 'test').run()
  }
  for (const [mailbox, userId, hidden] of [
    [address, owner.id, 0], ['bulk@example.net', owner.id, 0], ['foreign@example.com', 'read-other', 0],
    ['__unassigned__@omnimail.invalid', owner.id, 1], ['hidden@example.com', owner.id, 1],
  ]) {
    await env.DB.prepare('INSERT INTO mailboxes (address,user_id,is_hidden) VALUES (?,?,?)').bind(mailbox, userId, hidden).run()
  }
  for (const [mailbox, prefix, size] of [[address, 'target', 80], ['bulk@example.net', 'bulk', 1000], ['foreign@example.com', 'foreign', 200]]) {
    await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
      INSERT INTO messages (id,mailbox_address,direction,status,folder,sender_address,subject,received_at)
      SELECT ? || '-' || printf('%04d',x), ?, 'incoming','ready','inbox','sender@example.net','Test',10000+x FROM n`)
      .bind(size, prefix, mailbox).run()
  }
  await env.DB.prepare(`INSERT INTO messages (id,mailbox_address,delivered_to,direction,status,folder,sender_address,received_at)
    VALUES ('unassigned-1','__unassigned__@omnimail.invalid','unknown@example.com','incoming','ready','inbox','sender@example.net',20000),
      ('hidden-1','hidden@example.com',NULL,'incoming','ready','inbox','sender@example.net',20001)`).run()
  const before = measured()
  baseline = await list(before.environment)
  baselineRows = before.operations.reduce((sum, item) => sum + item.read, 0)
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) === 36))
})

describe('D1 邮件读取优化', () => {
  it('同一数据下保持返回结果，索引降低冷读取成本，翻页复用统计且不增加写入', async ({ annotate }) => {
    const fixture = measured()
    const first = await list(fixture.environment)
    const coldRows = fixture.operations.reduce((sum, item) => sum + item.read, 0)
    expect(first).toEqual(baseline)
    expect(coldRows).toBeLessThan(baselineRows * 0.5)
    expect(fixture.operations.every((item) => item.written === 0)).toBe(true)
    fixture.operations.length = 0
    const next = await list(fixture.environment, `mailbox=${address}&cursor=${first.page.nextCursor}`)
    expect(next.counts).toEqual(first.counts)
    expect(new Set([...first.messages, ...next.messages].map(({ id }) => id)).size).toBe(60)
    expect(fixture.operations.length).toBe(2)
    const warmRows = fixture.operations.reduce((sum, item) => sum + item.read, 0)
    expect(warmRows).toBeLessThan(coldRows)
    await annotate(JSON.stringify({ comparison: 'same-1282-messages', baselineRows, coldRows, warmRows }), 'benchmark')
  })

  it('缓存命中后遭遇并发写入，列表、统计和版本来自重新读取的同一批次', async () => {
    const fixture = measured()
    const first = await list(fixture.environment)
    fixture.beforeBatch(async () => {
      await env.DB.prepare("UPDATE messages SET is_read=1 WHERE id='target-0001'").run()
    })
    const changed = await list(fixture.environment)
    expect(changed.counts.unread).toBe(first.counts.unread - 1)
    expect(changed.version).toBeGreaterThan(first.version)
    await env.DB.prepare("UPDATE messages SET is_read=0 WHERE id='target-0001'").run()
  })

  it('地址、域名、其他用户与隐藏邮箱权限保持隔离', async () => {
    const fixture = measured()
    expect((await list(fixture.environment, 'mailbox=foreign@example.com')).counts.unread).toBe(0)
    expect((await list(fixture.environment, 'mailbox=unknown@example.com')).messages.map(({ id }) => id)).toEqual(['unassigned-1'])
    expect((await list(fixture.environment, 'mailbox=hidden@example.com')).counts.unread).toBe(0)
    const ordinary = { ...owner, role: 'user' } as SessionUser
    expect((await list(fixture.environment, 'mailbox=unknown@example.com', ordinary)).counts.unread).toBe(0)
    expect((await list(fixture.environment, 'domain=example.com')).counts.unread).toBe(81)
  })

  it('邮箱可见性变化、草稿新增与删除均会失效旧缓存', async () => {
    const fixture = measured()
    await list(fixture.environment)
    await env.DB.prepare('UPDATE mailboxes SET is_hidden=1 WHERE address=?').bind(address).run()
    expect((await list(fixture.environment)).counts.unread).toBe(0)
    await env.DB.prepare('UPDATE mailboxes SET is_hidden=0 WHERE address=?').bind(address).run()
    expect((await list(fixture.environment)).counts.unread).toBe(80)
    await env.DB.prepare('INSERT INTO mail_drafts (id,user_id,mailbox_address,created_at,updated_at) VALUES (?,?,?,?,?)')
      .bind('read-draft', owner.id, address, 1, 1).run()
    expect((await list(fixture.environment)).counts.drafts).toBe(1)
    await env.DB.prepare("DELETE FROM mail_drafts WHERE id='read-draft'").run()
    expect((await list(fixture.environment)).counts.drafts).toBe(0)
  })

  it('邮箱转移归属及实际收件地址变化时，使旧主人和新范围的统计失效', async () => {
    const fixture = measured()
    const other = { ...owner, id: 'read-other' }
    await list(fixture.environment)
    expect((await list(fixture.environment, `mailbox=${address}`, other)).counts.unread).toBe(0)
    await env.DB.prepare('UPDATE mailboxes SET user_id=? WHERE address=?').bind(other.id, address).run()
    expect((await list(fixture.environment)).counts.unread).toBe(0)
    expect((await list(fixture.environment, `mailbox=${address}`, other)).counts.unread).toBe(80)
    await env.DB.prepare('UPDATE mailboxes SET user_id=? WHERE address=?').bind(owner.id, address).run()
    await list(fixture.environment, 'mailbox=unknown@example.com')
    await env.DB.prepare("UPDATE messages SET delivered_to='renamed@example.com' WHERE id='unassigned-1'").run()
    expect((await list(fixture.environment, 'mailbox=unknown@example.com')).counts.unread).toBe(0)
    expect((await list(fixture.environment, 'mailbox=renamed@example.com')).counts.unread).toBe(1)
  })

  it('重复标记已读不写消息、不递增同步版本，真实变化才失效', async () => {
    const version = async () => (await env.DB.prepare('SELECT version FROM mail_state_versions WHERE user_id=?').bind(owner.id).first<{ version: number }>())!.version
    const before = await version()
    const request = new Request('https://mail.example.com/api/messages/target-0001', { method: 'PATCH', body: JSON.stringify({ isRead: false }) })
    expect((await updateMessage(env, owner, 'target-0001', request)).status).toBe(200)
    expect(await version()).toBe(before)
    const bulk = await bulkUpdateMessages(env, owner, new Request('https://mail.example.com/api/messages/bulk', {
      method: 'PATCH', body: JSON.stringify({ ids: ['target-0001'], action: 'unread' }),
    }), '')
    expect(await bulk.json()).toMatchObject({ updatedCount: 0 })
    expect(await version()).toBe(before)
    await env.DB.prepare("UPDATE messages SET is_read=is_read, subject=subject WHERE id='target-0001'").run()
    expect(await version()).toBe(before)
    await env.DB.prepare("UPDATE messages SET is_read=1 WHERE id='target-0001'").run()
    expect(await version()).toBe(before + 1)
  })
})
