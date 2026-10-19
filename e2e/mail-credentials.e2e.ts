import { expect, type Page, type Route, test } from '@playwright/test'
import { user } from './omnimail-fixtures'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function setup(page: Page, role = 'super_admin', ready = false, providers = [{ provider: 'Gmail', total: 20 }]) {
  const total = providers.reduce((sum, item) => sum + item.total, 0)
  const state = { ready, migrated: 0, posts: 0, reads: 0, delay: 0, fail: false }
  const status = () => ({
    globalKeyConfigured: state.ready, globalKeyReady: state.ready,
    keyId: state.ready ? '0123456789abcdef0123456789abcdef' : null,
    total, migrated: state.migrated, pending: total - state.migrated,
    providers: providers.map((item, index) => {
      const before = providers.slice(0, index).reduce((sum, previous) => sum + previous.total, 0)
      const migrated = Math.min(item.total, Math.max(0, state.migrated - before))
      return { ...item, migrated, pending: item.total - migrated, legacyKeyReady: true }
    }),
  })
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
  })
  await page.route('**://*/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/config') return json(route, {
      appName: 'OmniMail', setupComplete: true, replyEnabled: false,
      registrationEnabled: false, registrationAvailable: false, mailRefreshInterval: 30,
      remoteImagesEnabled: false, superAdminEmail: user.email,
    })
    if (path === '/api/session') return json(route, { user: { ...user, role } })
    if (path === '/api/mailboxes') return json(route, { mailboxes: [{ address: 'inbox@example.com', domain: 'example.com', isActive: true, isDefault: true }] })
    if (path === '/api/domains') return json(route, { domains: [] })
    if (path === '/api/drafts') return json(route, { drafts: [], limit: 5 })
    if (path === '/api/messages') return json(route, {
      unchanged: false, version: 1, messages: [], counts: { unread: 0, starred: 0, sent: 0, trash: 0 },
      page: { hasMore: false, nextCursor: null, limit: 30 },
    })
    if (path === '/api/admin/mail-credentials/migration') {
      if (route.request().method() === 'GET') { state.reads++; return json(route, status()) }
      state.posts++
      expect(route.request().postDataJSON()).toMatchObject({ confirm: true, keyId: '0123456789abcdef0123456789abcdef' })
      if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay))
      if (!state.fail) state.migrated = Math.min(total, state.migrated + 10)
      return json(route, {
        cursor: state.migrated < total && !state.fail ? { field: 3, afterId: 'batch-1' } : null,
        scanned: 10, migrated: state.fail ? 0 : 10, failed: state.fail ? 10 : 0, conflicts: 0, status: status(),
      })
    }
    return json(route, {}, 404)
  })
  return state
}

async function enterMigration(page: Page) {
  const introduction = page.getByRole('dialog', { name: '建议切换到全局密钥' })
  await expect(introduction).toBeVisible()
  await expect(introduction.getByRole('progressbar')).toHaveCount(0)
  await introduction.getByRole('button', { name: '开始设置', exact: true }).click()
  return page.getByRole('dialog', { name: '统一邮箱加密密钥' })
}

for (const viewport of [{ width: 900, height: 775 }, { width: 375, height: 667 }, { width: 812, height: 375 }, { width: 320, height: 568 }]) {
  test(`七种邮箱迁移在 ${viewport.width}×${viewport.height} 下正文独立滚动，按钮完整可见`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: viewport.width === 375 ? 'dark' : 'light' })
    await setup(page, 'super_admin', true, [
      { provider: 'iCloud', total: 6 }, { provider: 'Linux DO Mail', total: 1 }, { provider: 'Gmail', total: 2 },
      { provider: 'Microsoft', total: 27 }, { provider: 'QQ Mail', total: 1 }, { provider: 'NAVER Mail', total: 1 }, { provider: 'Yandex Mail', total: 1 },
    ])
    await page.goto('/')
    const dialog = await enterMigration(page)
    // 模拟其他懒加载页面随后注入共享样式，覆盖线上出现过的加载顺序。
    await page.addStyleTag({ path: 'src/features/deployment/styles/deployment-wizard.css' })
    await page.addStyleTag({ path: 'src/features/deployment/styles/deployment-wizard-responsive.css' })
    const body = dialog.locator('.mail-key-body')
    expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    expect(await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)).toMatch(/^rgb\(/)
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    for (const name of ['关闭', '暂不迁移', '重新检查配置', '开始 / 继续迁移']) {
      const button = dialog.getByRole('button', { name, exact: true })
      await expect(button).toBeInViewport({ ratio: 1 })
      const box = (await button.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    }
    const footer = dialog.locator('footer')
    const before = await footer.boundingBox()
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight })
    expect(await footer.boundingBox()).toEqual(before)
    await body.evaluate((element) => { element.scrollTop = 0 })
    await page.screenshot({ path: `test-results/mail-credentials-${viewport.width}x${viewport.height}.png`, fullPage: true })
  })
}

test('主管理员首页引导配置后主动迁移，完成前不会自动写入', async ({ page }) => {
  const state = await setup(page)
  await page.goto('/')
  const dialog = await enterMigration(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '开始 / 继续迁移' })).toBeDisabled()
  await expect(dialog.getByText('MAIL_CREDENTIALS_KEY', { exact: true })).toBeVisible()
  expect(state.posts).toBe(0)
  state.ready = true
  await dialog.getByRole('button', { name: '重新检查配置' }).click()
  await expect(dialog.getByText('全局密钥已就绪')).toBeVisible()
  expect(state.posts).toBe(0)
  await dialog.getByRole('button', { name: '开始 / 继续迁移' }).click()
  await expect(dialog.getByText('迁移完成', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '20')
  expect(state.posts).toBe(2)
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: '设置与迁移' })).toHaveCount(0)
})

test('关闭页面停止后续批次，重新打开恢复真实进度', async ({ page }) => {
  const state = await setup(page, 'super_admin', true)
  state.delay = 800
  await page.goto('/')
  const dialog = await enterMigration(page)
  await dialog.getByRole('button', { name: '开始 / 继续迁移' }).click()
  await expect.poll(() => state.posts).toBe(1)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect.poll(() => state.migrated).toBe(10)
  await page.getByRole('button', { name: '设置与迁移' }).click()
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '10')
  expect(state.posts).toBe(1)
  await dialog.getByRole('button', { name: '开始 / 继续迁移' }).click()
  await expect(dialog.getByText('迁移完成', { exact: true })).toBeVisible()
})

test('窄屏显示失败与重试，键盘可关闭，不误报完成', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' })
  const state = await setup(page, 'super_admin', true)
  state.fail = true
  await page.goto('/')
  const dialog = await enterMigration(page)
  await dialog.getByRole('button', { name: '开始 / 继续迁移' }).click()
  await expect(dialog.getByRole('alert')).toContainText('仍有凭据未迁移')
  await expect(dialog.getByText('迁移完成', { exact: true })).toHaveCount(0)
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/mail-credentials-mobile.png', fullPage: true })
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  state.fail = false
  await page.getByRole('button', { name: '设置与迁移' }).click()
  await dialog.getByRole('button', { name: '开始 / 继续迁移' }).click()
  await expect(dialog.getByText('迁移完成', { exact: true })).toBeVisible()
})

test('暂停后刷新页面仍可继续，不自动发起迁移', async ({ page }) => {
  const state = await setup(page, 'super_admin', true)
  state.delay = 800
  await page.goto('/')
  const dialog = await enterMigration(page)
  await dialog.getByRole('button', { name: '开始 / 继续迁移' }).click()
  await expect.poll(() => state.posts).toBe(1)
  await dialog.getByRole('button', { name: '暂停迁移' }).click()
  await expect(dialog.getByText('已暂停。当前批次已结束，可随时继续。')).toBeVisible()
  expect(state.migrated).toBe(10)
  expect(state.posts).toBe(1)
  await page.reload()
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '10')
  expect(state.posts).toBe(1)
  await dialog.getByRole('button', { name: '开始 / 继续迁移' }).click()
  await expect(dialog.getByText('迁移完成', { exact: true })).toBeVisible()
})

for (const role of ['user', 'admin']) {
  test(`${role} 不显示或请求主管理员密钥迁移状态`, async ({ page }) => {
    const state = await setup(page, role)
    await page.goto('/')
    await expect(page.locator('.reader-pane')).toBeVisible()
    expect(state.reads).toBe(0)
    await expect(page.getByRole('dialog', { name: '统一邮箱加密密钥' })).toHaveCount(0)
  })
}

test('升级说明可稍后处理，并在窄屏下从入口继续设置', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const state = await setup(page)
  await page.goto('/')
  const introduction = page.getByRole('dialog', { name: '建议切换到全局密钥' })
  await expect(introduction).toBeVisible()
  await expect(introduction.getByText('只需维护一份密钥', { exact: true })).toBeVisible()
  await expect(introduction.getByText('MAIL_CREDENTIALS_KEY', { exact: true })).toHaveCount(0)
  expect(await introduction.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/mail-key-introduction-mobile.png', fullPage: true })
  await introduction.getByRole('button', { name: '稍后处理' }).click()
  await expect(introduction).not.toBeVisible()
  expect(state.posts).toBe(0)
  await page.getByRole('button', { name: '设置与迁移' }).click()
  const migration = await enterMigration(page)
  await expect(migration.getByText('MAIL_CREDENTIALS_KEY', { exact: true })).toBeVisible()
  expect(state.posts).toBe(0)
})
