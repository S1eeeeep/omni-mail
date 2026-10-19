import { expect, test } from '@playwright/test'
import { message, user } from './omnimail-fixtures'

test('navigation stays usable on mobile and short desktop viewports', async ({ page }) => {
  let sessionRole: 'super_admin' | 'user' = 'super_admin'
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
    localStorage.setItem('omnimail-theme', 'dark')
  })
  await page.route('**://*/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    const responses: Record<string, unknown> = {
      '/api/config': {
        appName: 'OmniMail', setupComplete: true, replyEnabled: false,
        registrationEnabled: false, registrationAvailable: false,
        registrationMethod: 'password', linuxDoLoginEnabled: false,
        registrationDomainPolicy: { mode: 'blocklist', domains: [] },
        registrationProtectionReady: false, turnstileSiteKey: '',
        iCloudWorkspaceEnabled: true, linuxDoMailWorkspaceEnabled: true,
        gmailWorkspaceEnabled: true, microsoftWorkspaceEnabled: true,
        qqMailWorkspaceEnabled: true, naverMailWorkspaceEnabled: true,
        yandexMailWorkspaceEnabled: true,
        mailRefreshInterval: 30, remoteImagesEnabled: false,
        unassignedMailEnabled: false, superAdminEmail: user.email,
        setupRequirements: {
          databaseReady: true, storageReady: true, queueReady: true,
          superAdminReady: true, setupTokenReady: false,
        },
      },
      '/api/session': { user: { ...user, role: sessionRole } },
      '/api/mailboxes': { mailboxes: [{
        address: 'inbox@example.com', domain: 'example.com',
        isPrimary: true, isActive: true,
      }] },
      '/api/domains': { domains: [{
        name: 'example.com', isActive: true, mailboxCount: 1,
        createdAt: 1, updatedAt: 1,
      }] },
      '/api/messages': {
        unchanged: false, version: 1, messages: [message],
        counts: { unread: 0, starred: 0, sent: 0, trash: 0 },
        page: { hasMore: false, nextCursor: null, limit: 30 },
      },
    }
    const body = responses[path]
    return route.fulfill({
      status: body ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(body || { error: 'Not found' }),
    })
  })

  await page.setViewportSize({ width: 393, height: 800 })
  await page.goto('/')
  const sidebar = page.locator('.mail-sidebar')
  const navigation = sidebar.locator('.sidebar-navigation')
  const mobileToggle = page.locator('.mobile-sidebar-toggle')
  await expect(mobileToggle).toHaveAttribute('aria-label', '打开导航菜单')

  for (const width of [360, 393, 430]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(mobileToggle).toBeVisible()
    await expect(mobileToggle).toHaveAttribute('aria-expanded', 'false')
    const metrics = await mobileToggle.evaluate((element) => ({
      rect: element.getBoundingClientRect().toJSON(),
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }))
    expect(metrics.rect.width).toBeGreaterThanOrEqual(48)
    expect(metrics.rect.height).toBeGreaterThanOrEqual(48)
    expect(metrics.rect.left).toBeLessThanOrEqual(16)
    expect(metrics.pageOverflow).toBe(false)
  }
  await expect(sidebar).toHaveCSS('visibility', 'hidden')
  await mobileToggle.click()
  await expect(mobileToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(sidebar).toHaveCSS('visibility', 'visible')
  await expect(sidebar).toHaveCSS('transform', 'none')
  await expect(sidebar).toHaveAttribute('role', 'dialog')
  await expect(sidebar).toHaveAttribute('aria-modal', 'true')
  await expect(page.getByRole('button', { name: '关闭导航菜单' })).toBeFocused()
  await expect(navigation).toHaveCSS('overflow-y', 'auto')
  expect(await sidebar.locator('.folder-nav > button span').allTextContents())
    .toEqual(['收件箱', '星标邮件', '草稿箱', '已发送', '垃圾箱', 'iCloud 邮箱', 'Linux DO 邮箱', 'Gmail 邮箱', 'Microsoft 邮箱', 'QQ 邮箱', 'NAVER 邮箱', 'Yandex 邮箱'])
  const folderGeometry = await sidebar.locator('.folder-nav > button').evaluateAll((buttons) => (
    buttons.map((button) => {
      const rect = button.getBoundingClientRect()
      return { width: rect.width, height: rect.height, top: rect.top }
    })
  ))
  expect(folderGeometry.every(({ height }) => height >= 48)).toBe(true)
  expect(new Set(folderGeometry.map(({ top }) => Math.round(top))).size).toBe(folderGeometry.length)
  const adminNav = page.locator('.admin-nav')
  await expect(adminNav).toHaveCSS('visibility', 'visible')
  await expect(adminNav).toHaveCSS('transform', 'none')
  await expect(adminNav.getByRole('button')).toHaveCount(6)
  await page.keyboard.press('Escape')
  await expect(sidebar).toHaveCSS('visibility', 'hidden')
  await expect(mobileToggle).toBeFocused()

  await mobileToggle.click()
  await sidebar.getByRole('button', { name: '星标邮件' }).click()
  await expect(page).toHaveURL(/\/mail\/starred$/)
  await expect(sidebar).toHaveCSS('visibility', 'hidden')

  await page.setViewportSize({ width: 1280, height: 520 })
  await expect(mobileToggle).toHaveCSS('display', 'none')
  await expect(sidebar).toHaveCSS('visibility', 'visible')
  const brand = sidebar.locator('.sidebar-brand > .brand')
  await expect(brand).toContainText('OmniMail')
  expect(await brand.evaluate((element) => element.closest('a'))).toBeNull()
  const projectLinks = sidebar.getByRole('navigation', { name: 'OmniMail 项目链接' })
  const repositoryLink = projectLinks.getByRole('link', { name: '打开 OmniMail GitHub 仓库' })
  const websiteLink = projectLinks.getByRole('link', { name: '打开 OmniMail 官网' })
  await expect(repositoryLink).toHaveAttribute(
    'href', 'https://github.com/mibgb65-cloud/OmniMail',
  )
  await expect(websiteLink).toHaveAttribute('href', 'https://omnimail.aicnos.com')
  await expect(repositoryLink).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(websiteLink).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(repositoryLink).toBeVisible()
  await expect(websiteLink).toBeVisible()
  const [brandBox, projectLinksBox, repositoryBox, websiteBox, sidebarBox] = await Promise.all([
    brand.boundingBox(),
    projectLinks.boundingBox(),
    repositoryLink.boundingBox(),
    websiteLink.boundingBox(),
    sidebar.boundingBox(),
  ])
  expect(brandBox).not.toBeNull()
  expect(projectLinksBox).not.toBeNull()
  expect(repositoryBox).not.toBeNull()
  expect(websiteBox).not.toBeNull()
  expect(sidebarBox).not.toBeNull()
  expect(projectLinksBox!.x).toBeGreaterThanOrEqual(brandBox!.x + brandBox!.width)
  expect(Math.abs(projectLinksBox!.y + projectLinksBox!.height / 2
    - brandBox!.y - brandBox!.height / 2)).toBeLessThanOrEqual(2)
  expect(repositoryBox!.width).toBeGreaterThanOrEqual(24)
  expect(websiteBox!.x - repositoryBox!.x - repositoryBox!.width).toBeGreaterThanOrEqual(8)
  expect(websiteBox!.x + websiteBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width)
  expect(await sidebar.locator('.folder-nav > button span').allTextContents())
    .toEqual(['收件箱', '星标邮件', '草稿箱', '已发送', '垃圾箱', 'iCloud 邮箱', 'Linux DO 邮箱', 'Gmail 邮箱', 'Microsoft 邮箱', 'QQ 邮箱', 'NAVER 邮箱', 'Yandex 邮箱'])
  await expect(sidebar).toHaveCSS('overflow-y', 'hidden')
  await expect(navigation).toHaveCSS('overflow-y', 'scroll')
  expect(await navigation.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  const fixedBefore = await sidebar.evaluate((element) => ({
    brandTop: element.querySelector('.sidebar-brand')!.getBoundingClientRect().top,
    accountBottom: element.querySelector('.sidebar-account')!.getBoundingClientRect().bottom,
    sidebarScrollTop: element.scrollTop,
  }))
  const scrollbarStyles = async (locator: typeof navigation) => locator.evaluate((element) => ({
    gutter: getComputedStyle(element).scrollbarGutter,
    width: getComputedStyle(element).scrollbarWidth,
  }))
  expect(await scrollbarStyles(navigation)).toEqual(
    await scrollbarStyles(page.locator('.message-list')),
  )
  await navigation.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect(navigation).toHaveClass(/is-scrollbar-active/)
  await expect(sidebar.getByRole('button', { name: '账号设置' })).toBeInViewport()
  const fixedAfter = await sidebar.evaluate((element) => ({
    brandTop: element.querySelector('.sidebar-brand')!.getBoundingClientRect().top,
    accountBottom: element.querySelector('.sidebar-account')!.getBoundingClientRect().bottom,
    sidebarScrollTop: element.scrollTop,
  }))
  expect(Math.abs(fixedAfter.brandTop - fixedBefore.brandTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(fixedAfter.accountBottom - fixedBefore.accountBottom)).toBeLessThanOrEqual(1)
  expect(fixedAfter.sidebarScrollTop).toBe(0)
  await expect(navigation).not.toHaveClass(/is-scrollbar-active/, { timeout: 1_500 })

  await page.setViewportSize({ width: 393, height: 800 })
  sessionRole = 'user'
  await page.reload()
  await page.getByRole('button', { name: '打开导航菜单' }).click()
  await expect(page.getByRole('navigation', { name: '管理员功能' })).toHaveCount(0)
  await expect(page.locator('.folder-nav > button')).toHaveCount(12)
  await expect(page.locator('.account-nav > button')).toHaveCount(1)
})
