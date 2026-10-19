import { fetchApi } from './app/api'
import { cleanup } from './platform/scheduling/cleanup'
import { consumeEmailQueue, receiveEmail } from './app/handlers/mail'
import type { Env, MailQueueJob, NotificationQueueJob } from './app/types'
import { D1QuotaError, d1QuotaResponse, quotaEnvironment, quotaQueueDelay } from './platform/d1/quota-guard'
import { ensureSchema } from './platform/d1/schema'
import { consumeNotificationQueue, enqueuePendingNotifications, purgeOldNotifications } from './features/telegram/telegram-delivery'

export { OmniMailBackupWorkflow } from './features/backups/backup'
export { OmniMailCleanupWorkflow } from './platform/scheduling/cleanup-workflow'

async function fetchRequest(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path !== '/api' && !path.startsWith('/api/')) return env.ASSETS.fetch(request)
  const guarded = quotaEnvironment(env)
  const response = await fetchApi(request, guarded, context)
  const quota = response.status >= 500 ? d1QuotaResponse(guarded.DB) : undefined
  if (!quota) return response
  // 保留原中间件的 CORS 与安全响应头。
  const headers = new Headers(response.headers)
  quota.headers.forEach((value, key) => headers.set(key, value))
  return new Response(quota.body, { status: quota.status, headers })
}

export default {
  fetch: fetchRequest,
  email: (message, env) => receiveEmail(message, quotaEnvironment(env)),
  queue: async (batch, env) => {
    const guarded = quotaEnvironment(env)
    try {
      if (batch.queue === 'omnimail-notifications') {
        await ensureSchema(guarded.DB)
        await consumeNotificationQueue(batch as MessageBatch<NotificationQueueJob>, guarded)
        return
      }
      await consumeEmailQueue(batch as MessageBatch<MailQueueJob>, guarded)
      await enqueuePendingNotifications(guarded).catch(() => undefined)
    }
    catch (error) {
      if (!(error instanceof D1QuotaError)) throw error
      // 日额度耗尽不能通过数十秒重试恢复；保留任务，延迟到下一额度周期再尝试。
      batch.retryAll({ delaySeconds: quotaQueueDelay(error) })
    }
  },
  scheduled: async (_controller, env) => {
    const guarded = quotaEnvironment(env)
    try {
      await cleanup(guarded)
      await enqueuePendingNotifications(guarded)
      await purgeOldNotifications(guarded.DB)
    }
    catch (error) { if (!(error instanceof D1QuotaError)) throw error }
  },
} satisfies ExportedHandler<Env, MailQueueJob | NotificationQueueJob>
