import { Hono } from 'hono'
import type { AppContext } from './context'
import { registerMiddleware } from './middleware/register-middleware'
import { registerAccountRoutes } from './routes/account-routes'
import { registerAdminRoutes } from './routes/admin-routes'
import { registerMailRoutes } from './routes/mail-routes'
import { registerPublicRoutes } from './routes/public-routes'
import { registerTelegramRoutes } from '../features/telegram/telegram-routes'
import { logWorkerError } from '../shared/observability/structured-log'
import { d1QuotaResponse } from '../platform/d1/quota-guard'

const app = new Hono<AppContext>()

registerMiddleware(app)
registerPublicRoutes(app)
registerTelegramRoutes(app)
registerAccountRoutes(app)
registerAdminRoutes(app)
registerMailRoutes(app)

app.onError((error, context) => {
  const quota = d1QuotaResponse(context.env.DB)
  if (quota) return quota
  logWorkerError('api_unhandled_error', {
    method: context.req.method,
    path: new URL(context.req.url).pathname,
    cf_ray: context.req.header('CF-Ray') || '',
  }, error)
  return context.json({ error: '服务器暂时无法处理这个请求。' }, 500)
})

app.notFound((context) => context.json({ error: '接口不存在。' }, 404))

export const fetchApi = app.fetch
