import { env } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import type { MailQueueJob } from '../src/app/types'

describe('额度耗尽时的 Worker 行为', () => {
  it('返回明确 503，不重复访问 D1，健康检查仍可用，队列保留任务', async () => {
    const first = vi.fn(async () => { throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.") })
    const statement = { bind() { return this }, first }
    const DB = { prepare: () => statement } as unknown as D1Database
    const environment = { ...env, DB }
    const response = await worker.fetch(new Request('https://mail.example.com/api/config'), environment, createExecutionContext())
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBeTruthy()
    expect(await response.json()).toMatchObject({ code: 'd1_daily_limit' })
    const second = await worker.fetch(new Request('https://mail.example.com/api/config'), environment, createExecutionContext())
    expect(second.status).toBe(503)
    expect(first).toHaveBeenCalledTimes(1)
    expect((await worker.fetch(new Request('https://mail.example.com/api/health'), environment, createExecutionContext())).status).toBe(200)
    const batch = createMessageBatch<MailQueueJob>('test', [{ id: 'quota-job', timestamp: new Date(), attempts: 1, body: { kind: 'index', messageId: 'test-message' } }])
    const retry = vi.spyOn(batch, 'retryAll')
    const context = createExecutionContext()
    await worker.queue(batch, environment)
    const result = await getQueueResult(batch, context)
    expect(result.retryBatch.retry).toBe(true)
    expect(retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) })
    expect(retry.mock.calls[0][0]!.delaySeconds).toBeGreaterThan(0)
    expect(result.explicitAcks).toEqual([])
    expect(first).toHaveBeenCalledTimes(1)
  })
})
