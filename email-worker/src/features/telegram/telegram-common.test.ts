import { describe, expect, it } from 'vitest'
import { matchesWebhookSecret, newPairingCode, quietNow, readLimitedJson, validTimezone } from './telegram-common'

describe('Telegram input and quiet hours', () => {
  it('uses a short single-use link code shape and verifies the webhook secret', async () => {
    const code = newPairingCode()
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(await matchesWebhookSecret('abcdefghijklmnop', 'abcdefghijklmnop')).toBe(true)
    expect(await matchesWebhookSecret('abcdefghijklmnop', 'abcdefghijklmnox')).toBe(false)
  })

  it('bounds and validates JSON before parsing', async () => {
    const request = (body: string, type = 'application/json') => new Request('https://mail.example.com/api/webhooks/telegram', {
      method: 'POST', headers: { 'Content-Type': type }, body,
    })
    expect(await readLimitedJson(request('{"ok":true}'), 64)).toEqual({ ok: true })
    expect(await readLimitedJson(request('{"ok":true}'), 4)).toBeNull()
    expect(await readLimitedJson(request('{"ok":true}', 'text/plain'), 64)).toBeNull()
    expect(await readLimitedJson(request('{'), 64)).toBeNull()
  })

  it('handles an overnight quiet interval in the selected timezone', () => {
    expect(validTimezone('Asia/Singapore')).toBe(true)
    expect(validTimezone('Unknown/Zone')).toBe(false)
    expect(quietNow('22:00', '07:00', 'Asia/Singapore', new Date('2026-09-27T17:00:00Z'))).toBe(true)
    expect(quietNow('22:00', '07:00', 'Asia/Singapore', new Date('2026-09-27T04:00:00Z'))).toBe(false)
  })
})
