import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { enqueueSearchBackfill } from '../src/shared/mail/search-backfill'
import type { MailQueueJob } from '../src/app/types'

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare("INSERT INTO users(id,email,display_name,password_hash) VALUES('search-owner','search@example.com','Test','test')").run()
  await env.DB.prepare("INSERT INTO mailboxes(address,user_id) VALUES('search@example.com','search-owner')").run()
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<240)
    INSERT INTO messages(id,mailbox_address,direction,status,folder,sender_address,body_key)
    SELECT 'search-'||printf('%04d',x),'search@example.com','incoming','ready','inbox','sender@example.com','test-body' FROM n`).run()
})

describe('有界搜索索引补全', () => {
  it('队列失败保留游标，分批完成后不再周期性扫描消息表', async () => {
    const queued: string[] = []
    let fail = true
    let messageQueries = 0
    const environment = { ...env, DB: {
      prepare(sql: string) { if (sql.includes('FROM messages')) messageQueries++; return env.DB.prepare(sql) },
    } as D1Database, MAIL_QUEUE: {
      async send(job: MailQueueJob) {
        if (fail) throw new Error('queue unavailable')
        if (job.kind === 'index') queued.push(job.messageId)
      },
    } as unknown as Queue<MailQueueJob> }
    await expect(enqueueSearchBackfill(environment, 1000)).rejects.toThrow('queue unavailable')
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key='message_search_backfill_v2'").first()).toBeNull()
    fail = false
    for (let i = 0; i < 12; i++) await enqueueSearchBackfill(environment, 1000 + i)
    expect(queued).toHaveLength(240)
    expect(new Set(queued).size).toBe(240)
    const queries = messageQueries
    await enqueueSearchBackfill(environment, 2000)
    expect(messageQueries).toBe(queries)
    await enqueueSearchBackfill(environment, 1000 + 86_500)
    expect(messageQueries).toBeGreaterThan(queries)
  })
})
