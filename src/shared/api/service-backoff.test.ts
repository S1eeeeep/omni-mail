import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordServiceBackoff, serviceBackoff, serviceBackoffMessage } from './service-backoff'

afterEach(() => { serviceBackoff(Number.MAX_SAFE_INTEGER); vi.useRealTimers() })

describe('数据库额度提示与退避', () => {
  it('识别明确错误码，限制重试时间并在到期后允许请求', () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-09-13T07:00:00Z')
    expect(recordServiceBackoff({ error: 'normal failure' })).toBeUndefined()
    const state = recordServiceBackoff({ code: 'd1_daily_limit', retryAfterSeconds: 999999, resetAt: -1 })!
    expect(state.until).toBe(Date.now() + 300_000)
    expect(state.resetAt).toBe(Date.parse('2026-09-14T00:00:00Z'))
    expect(serviceBackoffMessage(state)).toContain('额度')
    vi.advanceTimersByTime(300_000)
    expect(serviceBackoff()).toBeUndefined()
  })

  it.each(['read', 'write'])('兼容旧后端透传的每日 %s 额度错误', (kind) => {
    expect(recordServiceBackoff({ error: `D1_ERROR: Your account has exceeded D1's free tier daily row ${kind} limit.` })).toBeDefined()
  })

  it('兼容每日操作限额提示，但不把其他 D1 故障或无效输入判断成额度耗尽', () => {
    expect(recordServiceBackoff({ error: 'D1 daily operation limit exceeded for database' })).toBeDefined()
    for (const error of [null, 42, {}, 'D1_ERROR: database is overloaded', 'D1 storage limit exceeded', 'D1 DB storage operation exceeded timeout', 'Daily row read limit', 'x'.repeat(4097)]) {
      expect(recordServiceBackoff({ error })).toBeUndefined()
    }
  })

  it('退避不跨过每日额度恢复时间', () => {
    const now = Date.parse('2026-09-13T23:59:55Z')
    const state = recordServiceBackoff({ code: 'd1_daily_limit', retryAfterSeconds: 60 }, now)!
    expect(state.until).toBe(Date.parse('2026-09-14T00:00:00Z'))
    expect(serviceBackoff(state.until)).toBeUndefined()
  })
})
