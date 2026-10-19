import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { listMailNotifications } from '../src/features/notifications/mail-notification-api'
import type { SessionUser } from '../src/app/types'

const owner = { id: 'notice-owner', role: 'user' } as SessionUser
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare("INSERT INTO users(id,email,display_name,password_hash) VALUES('notice-owner','notice@example.com','Test','test'),('notice-other','other@example.com','Other','test')").run()
  await env.DB.prepare("INSERT INTO gmail_imap_accounts(id,user_id,name,email,app_password_cipher,created_at,updated_at) VALUES('notice-gmail','notice-owner','Gmail','notice@gmail.com','test',1,1)").run()
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<120)
    INSERT INTO gmail_imap_messages(id,account_id,gmail_message_id,gmail_thread_id,imap_uid,uid_validity,internal_date,size_bytes,created_at,updated_at)
    SELECT 'notice-'||printf('%03d',x),'notice-gmail',CAST(x AS TEXT),'',x,1,x,1,1,1 FROM n`).run()
})

function fixture() {
  const metrics = { reads: 0, batches: 0 }
  const db = {
    prepare: (sql: string) => env.DB.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      metrics.batches++
      const results = await env.DB.batch(statements)
      metrics.reads += results.reduce((sum, result) => sum + result.meta.rows_read, 0)
      return results
    },
  } as unknown as D1Database
  return { environment: { ...env, DB: db }, metrics }
}

describe('通知查询与精确未读计数', () => {
  it('候选限量不会截断未读总数，版本未变化时不再读取消息表', async () => {
    const f = fixture()
    const request = () => new Request('https://mail.example.com/api/mail-notifications?limit=5&sources=gmail')
    const first = await (await listMailNotifications(f.environment, owner, request())).json() as { messages: unknown[]; unread: number }
    expect(first.messages).toHaveLength(5)
    expect(first.unread).toBe(120)
    const cold = f.metrics.reads
    const second = await (await listMailNotifications(f.environment, owner, request())).json()
    expect(second).toEqual(first)
    expect(f.metrics.batches).toBe(1)
    expect(f.metrics.reads).toBe(cold)
    await env.DB.prepare("UPDATE gmail_imap_messages SET is_read=1 WHERE id='notice-001'").run()
    const changed = await (await listMailNotifications(f.environment, owner, request())).json() as { unread: number }
    expect(changed.unread).toBe(119)
    expect(f.metrics.batches).toBe(2)
    const all = await (await listMailNotifications(f.environment, owner, new Request('https://mail.example.com/api/mail-notifications'))).json() as { unread: number }
    expect(all.unread).toBe(119)
  })
  it('账号更换归属、删除及用户级联删除不会串号或留下失效缓存', async () => {
    const f = fixture()
    const request = () => new Request('https://mail.example.com/api/mail-notifications?sources=gmail')
    await listMailNotifications(f.environment, owner, request())
    await env.DB.prepare("UPDATE gmail_imap_accounts SET user_id='notice-other' WHERE id='notice-gmail'").run()
    expect(await (await listMailNotifications(f.environment, owner, request())).json()).toMatchObject({ unread: 0, sources: [] })
    const other = { ...owner, id: 'notice-other' }
    expect(await (await listMailNotifications(f.environment, other, request())).json()).toMatchObject({ unread: 119, sources: ['gmail'] })
    await env.DB.prepare("DELETE FROM users WHERE id='notice-other'").run()
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_notification_versions WHERE user_id='notice-other'").first()).toEqual({ n: 0 })
  })
})
