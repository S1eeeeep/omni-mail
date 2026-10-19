import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api-client'
import { serviceBackoff } from './service-backoff'

afterEach(() => {
  serviceBackoff(Number.MAX_SAFE_INTEGER)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('API request timeouts', () => {
  it('收到明确额度错误后暂停后续网络请求，且不误清除登录状态', async () => {
    const fetch = vi.fn(async () => Response.json({ code: 'd1_daily_limit', retryAfterSeconds: 60, resetAt: Date.now() + 3600000 }, { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    await expect(api.config()).rejects.toMatchObject({ status: 503, quota: { resetAt: expect.any(Number) } })
    await expect(api.session()).rejects.toMatchObject({ status: 503, quota: { resetAt: expect.any(Number) } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([500, 503])('旧后端以 %s 返回英文额度错误时提供中文原因及恢复时间', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: "D1_ERROR: Your account has exceeded D1's free tier daily row read limit." }, { status })))
    await expect(api.config()).rejects.toMatchObject({ message: expect.stringContaining('数据库今日读写额度已用完'), quota: { resetAt: expect.any(Number) } })
  })

  it('普通数据库错误不触发全局退避', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'D1_ERROR: database is overloaded' }, { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    await expect(api.config()).rejects.toMatchObject({ status: 503, quota: undefined })
    await expect(api.session()).rejects.toThrow('database is overloaded')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('allows startup requests to survive a slow D1 cold path', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ user: null })))

    await api.config()
    await api.session()

    expect(timeout).toHaveBeenNthCalledWith(1, 30_000)
    expect(timeout).toHaveBeenNthCalledWith(2, 30_000)
  })

  it('uses the extended timeout for slow attachment and translation operations', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      attachment: {},
      translation: {},
    })))

    await api.uploadDraftAttachment('draft-1', new File(['x'], 'x.txt'))
    await api.translateMessage('message-1', 'en')

    expect(timeout).toHaveBeenCalledWith(60_000)
    expect(timeout).not.toHaveBeenCalledWith(15_000)
  })

  it('gives Gmail manual enqueue requests a longer fallback timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ queued: true })))

    await api.syncGmail('gmail-1')

    expect(timeout).toHaveBeenCalledWith(30_000)
  })
})
