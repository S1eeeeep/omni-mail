import { expect, test } from '@playwright/test'

test('启动时明确展示数据库日额度不足，并阻止立即重试反复请求', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('omnimail-locale', 'zh-CN'))
  let requests = 0
  await page.route('**://*/api/**', async (route) => {
    requests++
    await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Retry-After': '60' }, body: JSON.stringify({
      code: 'd1_daily_limit', retryAfterSeconds: 60, resetAt: Date.now() + 3600000,
      error: 'D1 每日读写额度已用完，请等待额度恢复或由管理员升级套餐。',
    }) })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '数据库今日额度已用完' })).toBeVisible()
  await expect(page.getByText('Cloudflare D1 数据库已达到今日读取或写入额度，邮箱暂时无法读取或保存数据。')).toBeVisible()
  await expect(page.getByText('预计恢复时间（本地时间）')).toBeVisible()
  await expect(page.locator('time')).toHaveAttribute('datetime', /T.*Z$/)
  const before = requests
  await page.getByRole('button', { name: '重新连接' }).click()
  await expect(page.getByRole('heading', { name: '数据库今日额度已用完' })).toBeVisible()
  expect(requests).toBe(before)
  await page.screenshot({ path: 'test-results/d1-quota-desktop.png', fullPage: true })
})

for (const kind of ['read', 'write']) {
  test(`旧后端每日 ${kind} 额度英文报错也展示中文原因，手机可查看恢复时间和重新连接`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.addInitScript(() => localStorage.setItem('omnimail-locale', 'zh-CN'))
    await page.route('**://*/api/**', (route) => route.fulfill({ status: 500, json: {
      error: `D1_ERROR: Your account has exceeded D1's free tier daily row ${kind} limit.`,
    } }))
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '数据库今日额度已用完' })).toBeVisible()
    await expect(page.getByText('预计恢复时间（本地时间）')).toBeVisible()
    await expect(page.getByRole('button', { name: '重新连接' })).toBeInViewport({ ratio: 1 })
    await expect(page.getByText(/Your account has exceeded/)).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    if (kind === 'read') await page.screenshot({ path: 'test-results/d1-quota-mobile.png', fullPage: true })
  })
}

test('普通服务器故障保留连接失败提示，允许正常重试', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('omnimail-locale', 'zh-CN'))
  let requests = 0
  await page.route('**://*/api/**', (route) => {
    requests++
    return route.fulfill({ status: 503, json: { error: '服务器暂时无法处理这个请求。' } })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '暂时无法连接邮箱' })).toBeVisible()
  await expect(page.getByText('预计恢复时间（本地时间）')).toHaveCount(0)
  const before = requests
  await page.getByRole('button', { name: '重新连接' }).click()
  await expect.poll(() => requests).toBeGreaterThan(before)
})
