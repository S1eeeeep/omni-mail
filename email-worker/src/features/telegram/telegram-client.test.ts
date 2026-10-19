import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTelegramBot, registerTelegramWebhook, sendTelegramMessage, sendTelegramRichMessage, sendTelegramTextDocument, TelegramApiError } from './telegram-client'

const token = '123456:abcdefghijklmnopqrstuvwxyz'
afterEach(() => vi.unstubAllGlobals())

describe('Telegram Bot API client', () => {
  it('validates the bot and registers a secret-header webhook', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, result: { id: 42, is_bot: true, username: 'omnimail_test_bot' } }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }))
    vi.stubGlobal('fetch', fetcher)
    expect(await getTelegramBot(token)).toEqual({ id: 42, username: 'omnimail_test_bot' })
    await registerTelegramWebhook(token, 'https://mail.example.com/api/webhooks/telegram', 'abcdefghijklmnop')
    const payload = JSON.parse((fetcher.mock.calls[1][1] as RequestInit).body as string) as {
      url: string; secret_token: string; allowed_updates: string[]
    }
    expect(payload).toEqual({
      url: 'https://mail.example.com/api/webhooks/telegram',
      secret_token: 'abcdefghijklmnop', allowed_updates: ['message'],
    })
  })

  it('sends plain text and maps Telegram retry-after without exposing the token', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false, error_code: 429, parameters: { retry_after: 17 },
    }), { status: 429, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(sendTelegramMessage(token, '123456', 'Mail alert')).rejects.toMatchObject({
      code: 'telegram_rate_limited', retryable: true, retryAfter: 17,
    })
    const failure = await sendTelegramMessage('invalid', '123456', 'Mail alert').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TelegramApiError)
    expect(String(failure)).not.toContain(token)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('treats a blocked bot chat as a permanent error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: false, error_code: 403 }), { status: 403 },
    )))
    await expect(sendTelegramMessage(token, '123456', 'Mail alert')).rejects.toMatchObject({
      code: 'telegram_forbidden', retryable: false,
    })
  })

  it('uploads a protected plain text document with its caption', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, result: { message_id: 1 } }))
    vi.stubGlobal('fetch', fetcher)
    await sendTelegramTextDocument(token, '123456', '完整正文\n第二行', 'OmniMail 收到新邮件')
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/sendDocument')
    expect(init.headers).toBeUndefined()
    const form = init.body as FormData
    expect(form.get('chat_id')).toBe('123456')
    expect(form.get('caption')).toBe('OmniMail 收到新邮件')
    expect(form.get('protect_content')).toBe('true')
    const document = form.get('document') as File
    expect(document.name).toBe('omnimail-message.txt')
    expect(await document.text()).toBe('完整正文\n第二行')
  })

  it('sends formatted HTML as a protected rich message', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, result: { message_id: 1 } }))
    vi.stubGlobal('fetch', fetcher)
    await sendTelegramRichMessage(token, '123456', '<p><b>新邮件</b></p>')
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/sendRichMessage')
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: '123456',
      rich_message: { html: '<p><b>新邮件</b></p>', skip_entity_detection: true },
      protect_content: true,
    })
  })
})
