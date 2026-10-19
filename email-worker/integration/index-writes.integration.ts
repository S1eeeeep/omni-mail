import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { messageStatement as gmail } from '../src/features/gmail/gmail-sync'
import { messageStatement as qq } from '../src/features/qq-mail/qq-mail-sync'
import { messageStatement as naver } from '../src/features/naver-mail/naver-mail-sync'
import { messageStatement as yandex } from '../src/features/yandex-mail/yandex-mail-sync'
import { messageStatement as microsoft } from '../src/features/microsoft/microsoft-sync'
import { refreshMicrosoftFolderWithClient } from '../src/features/microsoft/microsoft-sync'
import type { MicrosoftImapClient } from '../src/features/microsoft/microsoft-imap'
import { messageStatement as external } from '../src/features/external-mail/external-mail-sync'

const metadata = {
  imapUid: 1, uid: 1, gmailMessageId: 'remote-1', gmailThreadId: 'thread-1',
  internetMessageId: '<test@example.com>', messageIdHeader: '<test@example.com>',
  senderName: 'Test', senderAddress: 'sender@example.com', recipients: ['inbox@example.com'], cc: [],
  subject: 'Test', preview: '', internalDate: 100, receivedAt: 100, sentAt: null,
  sizeBytes: 100, flags: ['\\Recent'], labels: ['INBOX'], isRead: false, isStarred: false, hasAttachments: false,
}
const sources = [
  ['gmail', (message: typeof metadata, now: number) => gmail(env, 'gmail', 1, message, now)],
  ['qq', (message: typeof metadata, now: number) => qq(env, 'qq', 1, message, now)],
  ['naver', (message: typeof metadata, now: number) => naver(env, 'naver', 1, message, now)],
  ['yandex', (message: typeof metadata, now: number) => yandex(env, 'yandex', 1, message, now)],
  ['microsoft', (message: typeof metadata, now: number) => microsoft(env, 'microsoft', 'INBOX', 1, message, now)],
  ['icloud', (message: typeof metadata, now: number) => external(env, 'icloud', 'icloud', 1, message, now)],
  ['linuxdo', (message: typeof metadata, now: number) => external(env, 'linuxdo', 'linuxdo', 1, message, now)],
] as const

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare("INSERT INTO users(id,email,display_name,password_hash) VALUES('index-owner','index@example.com','Test','test')").run()
  const statements = [
    "INSERT INTO gmail_imap_accounts(id,user_id,name,email,app_password_cipher,created_at,updated_at) VALUES('gmail','index-owner','Gmail','a@gmail.com','test',1,1)",
    "INSERT INTO qq_mail_accounts(id,user_id,name,email,authorization_code_cipher,created_at,updated_at) VALUES('qq','index-owner','QQ','a@qq.com','test',1,1)",
    "INSERT INTO naver_mail_accounts(id,user_id,name,email,naver_id,app_password_cipher,created_at,updated_at) VALUES('naver','index-owner','NAVER','a@naver.com','a','test',1,1)",
    "INSERT INTO yandex_mail_accounts(id,user_id,name,email,yandex_login,app_password_cipher,created_at,updated_at) VALUES('yandex','index-owner','Yandex','a@yandex.com','a','test',1,1)",
    "INSERT INTO microsoft_imap_accounts(id,user_id,name,provided_email,normalized_email,auth_mode,client_id,refresh_token_cipher,created_at,updated_at) VALUES('microsoft','index-owner','Microsoft','a@outlook.com','a@outlook.com','oauth2','test','test',1,1)",
    "INSERT INTO icloud_accounts(id,user_id,name,created_at,updated_at) VALUES('icloud','index-owner','iCloud','1','1')",
    "INSERT INTO linux_do_mail_accounts(id,user_id,username,password_cipher,created_at,updated_at) VALUES('linuxdo','index-owner','a@linux.do','test','1','1')",
  ]
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)))
  await env.DB.prepare("INSERT INTO microsoft_imap_folders(account_id,path,display_name,flags_json,last_listed_at) VALUES('microsoft','INBOX','INBOX','[]',1)").run()
})

describe('外部邮箱索引按变化写入', () => {
  it.each(sources)('%s 相同元数据、重复标志和缺失日期不会重写，已读改变会写入', async (_source, statement) => {
    expect((await statement(metadata, 100).run()).meta.changes).toBeGreaterThan(0)
    const unchanged = await statement({ ...metadata, flags: ['\\Recent', '\\Recent'] }, 200).run()
    expect(unchanged.meta.changes).toBe(0)
    expect(unchanged.meta.rows_written).toBe(0)
    const missingDate = await statement({ ...metadata, internalDate: 0, receivedAt: 0 }, 300).run()
    expect(missingDate.meta.rows_written).toBe(0)
    expect((await statement({ ...metadata, isRead: true }, 400).run()).meta.changes).toBeGreaterThan(0)
  })
  it('连续同步仍核对远端已读状态，但第二次不重复写邮件或空裁剪', async ({ annotate }) => {
    let trimQueries = 0
    const writes: number[] = []
    const db = {
      prepare(sql: string) { if (sql.includes('id NOT IN')) trimQueries++; return env.DB.prepare(sql) },
      async batch(statements: D1PreparedStatement[]) {
        const results = await env.DB.batch(statements)
        writes.push(results.reduce((sum, result) => sum + result.meta.rows_written, 0))
        return results
      },
    } as unknown as D1Database
    let reads = 0
    const client = {
      examineFolder: async () => ({ uidValidity: 1 }), searchAllUids: async () => [1],
      fetchMetadata: async () => { reads++; return [metadata] },
    } as unknown as MicrosoftImapClient
    await refreshMicrosoftFolderWithClient({ ...env, DB: db }, 'microsoft', 'INBOX', 20, client, 1000)
    await refreshMicrosoftFolderWithClient({ ...env, DB: db }, 'microsoft', 'INBOX', 20, client, 1100)
    expect(reads).toBe(2)
    expect(trimQueries).toBe(1)
    expect(writes[1]).toBeLessThan(writes[0])
    await annotate(JSON.stringify({ comparison: 'microsoft-repeated-sync', firstWrites: writes[0], unchangedWrites: writes[1], trimQueries }), 'benchmark')
  })
})
