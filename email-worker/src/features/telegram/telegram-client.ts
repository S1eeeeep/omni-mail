export class TelegramApiError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfter = 0,
  ) {
    super(code)
  }
}

interface TelegramResponse<T> {
  ok?: boolean
  result?: T
  error_code?: number
  parameters?: { retry_after?: number }
}

async function callTelegram<T>(
  token: string,
  method: string,
  body: Record<string, unknown> | FormData,
): Promise<T> {
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token)) {
    throw new TelegramApiError('invalid_bot_token', false)
  }
  let response: Response
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      ...(body instanceof FormData ? { body } : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      signal: AbortSignal.timeout(body instanceof FormData ? 20_000 : 10_000),
    })
  } catch {
    // Bot Token 在请求 URL 中，绝不能把原始网络异常写入日志。
    throw new TelegramApiError('telegram_network', true)
  }
  let parsed: TelegramResponse<T>
  try {
    const text = await response.text()
    if (text.length > 32_768) throw new Error('response_too_large')
    parsed = JSON.parse(text) as TelegramResponse<T>
  } catch {
    throw new TelegramApiError('telegram_response', true)
  }
  if (!response.ok || parsed.ok !== true || parsed.result === undefined) {
    const status = Number.isInteger(parsed.error_code) ? parsed.error_code! : response.status
    const retryAfter = parsed.parameters?.retry_after
    const delay = Number.isSafeInteger(retryAfter) && retryAfter! > 0
      ? Math.min(retryAfter!, 3600) : 0
    throw new TelegramApiError(
      status === 429 ? 'telegram_rate_limited'
        : status === 403 ? 'telegram_forbidden'
          : status >= 500 ? 'telegram_server' : 'telegram_rejected',
      status === 429 || status >= 500,
      delay,
    )
  }
  return parsed.result
}

export async function getTelegramBot(token: string): Promise<{ id: number; username: string }> {
  const bot = await callTelegram<{ id?: number; username?: string; is_bot?: boolean }>(token, 'getMe', {})
  if (bot.is_bot !== true || !Number.isSafeInteger(bot.id) || bot.id! <= 0
    || typeof bot.username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username)) {
    throw new TelegramApiError('telegram_bot_identity', false)
  }
  return { id: bot.id!, username: bot.username }
}

export async function registerTelegramWebhook(
  token: string,
  url: string,
  secret: string,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
    throw new TelegramApiError('invalid_webhook_secret', false)
  }
  const registered = await callTelegram<boolean>(token, 'setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message'],
  })
  if (registered !== true) throw new TelegramApiError('telegram_webhook_rejected', false)
}

export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  if (!/^-?\d{1,20}$/.test(chatId) || text.length < 1 || text.length > 4096) {
    throw new TelegramApiError('invalid_telegram_message', false)
  }
  await callTelegram<object>(token, 'sendMessage', {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    protect_content: true,
  })
}

export async function sendTelegramRichMessage(token: string, chatId: string, html: string): Promise<void> {
  if (!/^-?\d{1,20}$/.test(chatId) || !html || html.length > 24_000
    || new TextEncoder().encode(html).byteLength > 32_000) {
    throw new TelegramApiError('invalid_telegram_rich_message', false)
  }
  await callTelegram<object>(token, 'sendRichMessage', {
    chat_id: chatId,
    rich_message: { html, skip_entity_detection: true },
    protect_content: true,
  })
}

export async function sendTelegramTextDocument(
  token: string,
  chatId: string,
  text: string,
  caption: string,
): Promise<void> {
  if (!/^-?\d{1,20}$/.test(chatId) || text.length < 1 || caption.length < 1
    || caption.length > 1024 || new TextEncoder().encode(text).byteLength > 1_000_000) {
    throw new TelegramApiError('invalid_telegram_document', false)
  }
  const form = new FormData()
  form.set('chat_id', chatId)
  form.set('caption', caption)
  form.set('protect_content', 'true')
  form.set('document', new Blob([text], { type: 'text/plain; charset=utf-8' }), 'omnimail-message.txt')
  await callTelegram<object>(token, 'sendDocument', form)
}
