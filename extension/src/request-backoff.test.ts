import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordRequestPause, requestPause } from './request-backoff'
afterEach(() => vi.useRealTimers())
describe('扩展额度退避', () => {
  it('按实例隔离且不因普通错误或账号切换阻塞其他实例', () => {
    vi.useFakeTimers()
    recordRequestPause('https://one.example', { code: 'd1_daily_limit', retryAfterSeconds: 60, error: 'quota' }, 503)
    expect(requestPause('https://one.example')).toBe('quota')
    expect(requestPause('https://two.example')).toBeUndefined()
    recordRequestPause('https://two.example', { error: 'unavailable' }, 503)
    expect(requestPause('https://two.example')).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(requestPause('https://one.example')).toBeUndefined()
  })
})
