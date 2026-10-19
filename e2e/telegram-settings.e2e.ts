import { expect, test } from '@playwright/test'
import { user } from './omnimail-fixtures'

test('account settings save Telegram sources and privacy choices', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 })
  let saved: Record<string, unknown> | null = null
  const telegram = {
    configured: true, botUsername: 'omnimail_test_bot', connected: true,
    enabled: true, status: 'active',
    sources: ['omnimail', 'gmail', 'qq'], detailLevel: 'basic', includeBody: false,
    bodyFormat: 'text',
    quietEnabled: false, quietStart: '22:00', quietEnd: '07:00',
    timezone: 'Asia/Singapore', lastErrorCode: '',
  }
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
    localStorage.setItem('omnimail-theme', 'dark')
  })
  await page.route('**://*/api/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/notification-channels/telegram') {
      if (request.method() === 'PATCH') {
        saved = request.postDataJSON() as Record<string, unknown>
        Object.assign(telegram, saved)
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(telegram) })
    }
    const responses: Record<string, unknown> = {
      '/api/config': {
        appName: 'OmniMail', setupComplete: true, replyEnabled: false,
        registrationEnabled: false, registrationAvailable: false,
        registrationMethod: 'password', linuxDoLoginEnabled: false,
        registrationDomainPolicy: { mode: 'blocklist', domains: [] },
        registrationProtectionReady: false, turnstileSiteKey: '',
        mailRefreshInterval: 0, remoteImagesEnabled: false,
        unassignedMailEnabled: false, superAdminEmail: user.email,
        setupRequirements: { databaseReady: true, storageReady: true,
          queueReady: true, superAdminReady: true, setupTokenReady: false },
      },
      '/api/session': { user },
      '/api/mailboxes': { mailboxes: [] },
      '/api/domains': { domains: [] },
      '/api/messages': { unchanged: false, version: 1, messages: [],
        counts: { unread: 0, starred: 0, sent: 0, trash: 0 },
        page: { hasMore: false, nextCursor: null, limit: 30 } },
    }
    return route.fulfill({ status: path in responses ? 200 : 404,
      contentType: 'application/json', body: JSON.stringify(responses[path] ?? {}) })
  })
  await page.goto('/settings/account')
  const card = page.locator('.telegram-card')
  await expect(card.getByText('已连接 Telegram 私聊', { exact: true }))
    .toBeVisible({ timeout: 15_000 })
  await expect(card.getByRole('button', { name: '验证并注册 Telegram Bot' })).toBeHidden()
  const saveButton = card.getByRole('button', { name: '保存通知设置' })
  const testButton = card.getByRole('button', { name: '发送测试消息' })
  const saveBounds = await saveButton.boundingBox()
  const testBounds = await testButton.boundingBox()
  expect(saveBounds).not.toBeNull()
  expect(testBounds).not.toBeNull()
  expect(testBounds!.y).toBeGreaterThan(saveBounds!.y)
  await card.getByRole('checkbox', { name: 'Gmail' }).uncheck()
  await card.getByRole('combobox', { name: '消息内容' }).selectOption('sender')
  await card.getByRole('checkbox', { name: '发送 OmniMail 主邮箱正文' }).check()
  await card.getByRole('combobox', { name: '正文格式' }).selectOption('rich')
  await card.getByRole('checkbox', { name: '启用免打扰' }).check()
  await saveButton.click()
  await expect.poll(() => saved).toMatchObject({
    sources: ['omnimail', 'qq'], detailLevel: 'sender', includeBody: true,
    bodyFormat: 'rich', quietEnabled: true,
    timezone: 'Asia/Singapore',
  })
  await expect(card.getByText('Telegram 通知设置已保存。')).toBeVisible()
  await card.getByText('Bot 管理').click()
  await expect(card.getByRole('button', { name: '验证并注册 Telegram Bot' })).toBeVisible()

  await page.setViewportSize({ width: 375, height: 812 })
  const mobileSaveBounds = await saveButton.boundingBox()
  const mobileTestBounds = await testButton.boundingBox()
  expect(mobileTestBounds!.x).toBe(mobileSaveBounds!.x)
  expect(mobileTestBounds!.y).toBeGreaterThan(mobileSaveBounds!.y)
})
