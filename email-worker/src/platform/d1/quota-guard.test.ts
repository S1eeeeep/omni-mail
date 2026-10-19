import { afterEach, describe, expect, it, vi } from 'vitest'
import { D1QuotaError, d1QuotaResponse, guardedD1, isD1QuotaError, quotaQueueDelay } from './quota-guard'
import { ensureSchema } from './schema'

const quota = new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.")
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function fixture() {
  const first = vi.fn().mockRejectedValue(quota)
  const statement = { bind() { return this }, first, all: first, run: first }
  const batch = vi.fn().mockRejectedValue(quota)
  const db = { prepare: vi.fn(() => statement), batch } as unknown as D1Database
  return { original: db, db: guardedD1(db), first, batch, statement }
}

describe('D1 额度保护', () => {
  it('缓存同一绑定的保护器，额度耗尽后阻止重复查询，恢复后自动解除', async () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-09-13T07:00:00Z')
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const f = fixture()
    expect(guardedD1(f.original)).toBe(f.db)
    await expect(f.db.prepare('SELECT 1').first()).rejects.toBeInstanceOf(D1QuotaError)
    await expect(f.db.prepare('SELECT 1').first()).rejects.toBeInstanceOf(D1QuotaError)
    expect(f.first).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
    const response = d1QuotaResponse(f.db)!
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('30')
    expect(await response.json()).toMatchObject({ code: 'd1_daily_limit', resetAt: Date.parse('2026-09-14T00:00:00Z') })
    vi.advanceTimersByTime(30_000)
    f.first.mockResolvedValue({ value: 1 })
    await expect(f.db.prepare('SELECT 1').first()).resolves.toEqual({ value: 1 })
    expect(d1QuotaResponse(f.db)).toBeUndefined()
  })
  it('普通数据库错误不触发额度退避，也不误进入建表恢复', async () => {
    const f = fixture()
    f.first.mockRejectedValue(new Error('D1_ERROR: database temporarily unavailable'))
    await expect(ensureSchema(f.db)).rejects.toThrow('temporarily unavailable')
    expect(f.first).toHaveBeenCalledTimes(1)
    expect(f.batch).not.toHaveBeenCalled()
    expect(d1QuotaResponse(f.db)).toBeUndefined()
    expect(isD1QuotaError(new Error('other error'))).toBe(false)
  })
  it('批次解包语句并保留正常语义，重复失败增加退避，队列等到重置而不确认丢弃', async () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-09-13T07:00:00Z')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const f = fixture()
    await expect(f.db.batch([f.db.prepare('SELECT 1').bind(1)])).rejects.toBeInstanceOf(D1QuotaError)
    expect(f.batch).toHaveBeenCalledWith([f.statement])
    vi.advanceTimersByTime(30_000)
    await expect(f.db.batch([])).rejects.toBeInstanceOf(D1QuotaError)
    expect(d1QuotaResponse(f.db)?.headers.get('Retry-After')).toBe('60')
    const delayed = new D1QuotaError(Date.parse('2026-09-14T00:00:00Z'), Date.now() + 60_000)
    expect(quotaQueueDelay(delayed)).toBeGreaterThan(60_000)
    expect(quotaQueueDelay(delayed)).toBeLessThanOrEqual(86_400)
  })
})
