import { describe, expect, it, vi } from 'vitest'
import { ImapConnectionError } from '../../platform/imap/imap-errors'
import {
  enqueueDueYandexMailSyncs,
  missingYandexMailUids,
  yandexMailSyncErrorCode,
  selectYandexMailFetchUids,
} from './yandex-mail-sync'
import type { YandexMailMessageMetadata } from './yandex-mail-types'
import type { Env, MailQueueJob } from '../../app/types'

describe('Yandex Mail synchronization policy', () => {
  it('identifies indexed UIDs that disappeared from INBOX', () => {
    expect(missingYandexMailUids(
      [10, 11, 12],
      [{ imapUid: 10 }, { imapUid: 12 }] as YandexMailMessageMetadata[],
    )).toEqual([11])
  })

  it('classifies authentication, timeout, and oversized responses without server text', () => {
    expect(yandexMailSyncErrorCode(new ImapConnectionError(400, 'secret remote response')))
      .toBe('authentication_failed')
    expect(yandexMailSyncErrorCode(new ImapConnectionError(504, 'timeout'))).toBe('timeout')
    expect(yandexMailSyncErrorCode(new ImapConnectionError(502, '响应超过读取上限')))
      .toBe('response_too_large')
  })

  it('fetches at most 20 recent and 20 newly discovered messages per run', () => {
    const recent = Array.from({ length: 30 }, (_, index) => 30 - index)
    const discovered = Array.from({ length: 30 }, (_, index) => 101 + index)

    expect(selectYandexMailFetchUids(recent, discovered)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => 11 + index),
      ...Array.from({ length: 20 }, (_, index) => 101 + index),
    ])
  })

  it('只配置统一密钥即可按 15 分钟间隔调度到期账号', async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const jobs: MailQueueJob[] = []
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...bindings: unknown[]) => {
          statements.push({ sql, bindings })
          return {
            all: async () => ({ results: [{ id: 'yandex-account-1' }] }),
            run: async () => ({ meta: { changes: 1 } }),
          }
        },
      })),
    } as unknown as D1Database
    const env = {
      DB: db,
      MAIL_QUEUE: { send: async (job: MailQueueJob) => { jobs.push(job) } },
      MAIL_CREDENTIALS_KEY: 'yandex-mail-test-key-that-is-longer-than-thirty-two-bytes',
    } as unknown as Env

    await expect(enqueueDueYandexMailSyncs(env, 1_000)).resolves.toBe(1)
    expect(jobs).toEqual([{
      kind: 'yandex-mail-sync', accountId: 'yandex-account-1', reason: 'scheduled',
    }])
    expect(statements[0].sql).toContain("OR status = 'syncing'")
    expect(statements[1].sql).toContain("THEN 'stale_lease'")
    expect(statements.some(({ sql, bindings }) => (
      sql.includes('UPDATE yandex_mail_accounts')
      && bindings[0] === 1_900
    ))).toBe(true)
  })

  it('缺少有效密钥时不查询 D1 或调度同步', async () => {
    const prepare = vi.fn()
    const env = {
      DB: { prepare },
      MAIL_CREDENTIALS_KEY: 'short',
    } as unknown as Env

    await expect(enqueueDueYandexMailSyncs(env)).resolves.toBe(0)
    expect(prepare).not.toHaveBeenCalled()
  })
})
