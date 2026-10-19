import type { Hono, MiddlewareHandler } from 'hono'
import type { AppContext } from '../../app/context'
import {
  createTelegramPairing, disconnectTelegram, getTelegramStatus, handleTelegramWebhook,
  registerTelegramBot, testTelegram, updateTelegramSettings,
} from './telegram-api'

export function registerTelegramRoutes(app: Hono<AppContext>): void {
  const cookieOnly: MiddlewareHandler<AppContext> = async (context, next) => {
    if (context.get('authKind') !== 'cookie') return context.json({ error: '请通过网页登录管理 Telegram 通知。' }, 403)
    await next()
  }
  app.use('/api/notification-channels/telegram', cookieOnly)
  app.use('/api/notification-channels/telegram/*', cookieOnly)
  app.post('/api/webhooks/telegram', (context) => handleTelegramWebhook(context.env, context.req.raw))
  app.post('/api/admin/notification-channels/telegram/webhook', (context) => (
    registerTelegramBot(context.env, context.get('user'), context.req.raw, context.get('authKind'))
  ))
  app.get('/api/notification-channels/telegram', (context) => (
    getTelegramStatus(context.env, context.get('user'))
  ))
  app.post('/api/notification-channels/telegram/pairing', (context) => (
    createTelegramPairing(context.env, context.get('user'))
  ))
  app.patch('/api/notification-channels/telegram', (context) => (
    updateTelegramSettings(context.env, context.get('user'), context.req.raw)
  ))
  app.post('/api/notification-channels/telegram/test', (context) => (
    testTelegram(context.env, context.get('user'))
  ))
  app.delete('/api/notification-channels/telegram', (context) => (
    disconnectTelegram(context.env, context.get('user'))
  ))
}
