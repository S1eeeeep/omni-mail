import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedMessageCounts, cacheMessageCounts } from './message-count-cache'

const counts = { unread: 1, starred: 2, sent: 3, trash: 4, drafts: 5 }
afterEach(() => vi.useRealTimers())

describe('邮件数量缓存', () => {
  it('隔离绑定、用户和权限范围，并在版本变化时失效', () => {
    const db = {} as D1Database
    cacheMessageCounts(db, 'user-a:super_admin:all', 1, counts)
    expect(cachedMessageCounts(db, 'user-a:super_admin:all', 1)).toEqual(counts)
    expect(cachedMessageCounts({} as D1Database, 'user-a:super_admin:all', 1)).toBeUndefined()
    expect(cachedMessageCounts(db, 'user-a:user:all', 1)).toBeUndefined()
    expect(cachedMessageCounts(db, 'user-b:super_admin:all', 1)).toBeUndefined()
    expect(cachedMessageCounts(db, 'user-a:super_admin:all', 2)).toBeUndefined()
  })
  it('访问不延长有效期，返回值不能污染缓存', () => {
    vi.useFakeTimers()
    const db = {} as D1Database
    cacheMessageCounts(db, 'scope', 1, counts)
    cachedMessageCounts(db, 'scope', 1)!.unread = 100
    expect(cachedMessageCounts(db, 'scope', 1)?.unread).toBe(1)
    vi.advanceTimersByTime(59_000)
    expect(cachedMessageCounts(db, 'scope', 1)).toBeDefined()
    vi.advanceTimersByTime(1_000)
    expect(cachedMessageCounts(db, 'scope', 1)).toBeUndefined()
  })
  it('容量有界，淘汰最久未使用的范围', () => {
    const db = {} as D1Database
    for (let i = 0; i < 256; i++) cacheMessageCounts(db, String(i), 1, counts)
    expect(cachedMessageCounts(db, '0', 1)).toBeDefined()
    cacheMessageCounts(db, '256', 1, counts)
    expect(cachedMessageCounts(db, '1', 1)).toBeUndefined()
    expect(cachedMessageCounts(db, '0', 1)).toBeDefined()
  })
})
