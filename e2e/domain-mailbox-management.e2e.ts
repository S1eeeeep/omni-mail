import { expect, test, type Page } from '@playwright/test'
import { user } from './omnimail-fixtures'

const jobId = '00000000-0000-4000-8000-000000000001'
const summary = { mailboxCount: 1, userCount: 1, messageCount: 4, draftCount: 1, attachmentCount: 2, bytes: 2048, unassignedMessageCount: 3 }

async function setup(page: Page, role: 'admin' | 'super_admin' = 'super_admin', primary = false) {
  const state = { present: true, active: true, submitted: false, status: 'pending', previewBody: null as unknown, removeMode: '', retries: 0, rejectSubmit: false }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
  })
  await page.route('**://*/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (path === '/api/config') return json({
      appName: 'OmniMail', setupComplete: true, replyEnabled: false,
      registrationEnabled: false, registrationAvailable: false, registrationMethod: 'password',
      linuxDoLoginEnabled: false, registrationDomainPolicy: { mode: 'blocklist', domains: [] },
      registrationProtectionReady: false, turnstileSiteKey: '', mailRefreshInterval: 0,
      remoteImagesEnabled: false, unassignedMailEnabled: false, superAdminEmail: user.email,
      setupRequirements: { databaseReady: true, storageReady: true, queueReady: true, superAdminReady: true, setupTokenReady: false },
    })
    if (path === '/api/session') return json({ user: { ...user, role } })
    if (path === '/api/mailboxes') return json({ mailboxes: [] })
    if (path === '/api/domains') return json({ domains: state.present ? [{ name: 'example.com', isActive: state.active, mailboxCount: 2, createdAt: 1, updatedAt: 1 }] : [] })
    if (path === '/api/messages') return json({ unchanged: false, version: 1, messages: [], counts: { unread: 0, starred: 0, sent: 0, trash: 0, drafts: 0 }, page: { hasMore: false, nextCursor: null, limit: 30 } })
    if (path === '/api/admin/domains/example.com' && request.method() === 'DELETE') {
      state.removeMode = url.searchParams.get('mode') || ''
      state.present = false
      return json({ ok: true })
    }
    if (path === '/api/admin/domains/example.com/mailboxes') return json({
      mailboxes: state.status === 'completed' ? [] : [
        { address: 'alias@example.com', userId: 'user-2', userEmail: 'other@example.net', displayName: 'Other user', isPrimary: false, isActive: true, domainActive: state.active, isCleaning: state.submitted },
        { address: 'owner@example.com', userId: user.id, userEmail: user.email, displayName: user.displayName, isPrimary: primary, isActive: true, domainActive: state.active, isCleaning: state.submitted },
      ],
      totals: { total: state.status === 'completed' ? 0 : 2, primaryCount: primary ? 1 : 0, cleaningCount: state.submitted ? 2 : 0 },
      page: { hasMore: false, nextCursor: null, limit: 50 }, activeJob: state.submitted && state.status !== 'completed' ? { id: jobId, status: state.status } : null,
    })
    if (path === '/api/admin/domains/example.com/cleanup/preview') {
      state.previewBody = request.postDataJSON()
      return json({ jobId, summary, expiresAt: Math.floor(Date.now() / 1000) + 600 })
    }
    if (path === '/api/admin/domains/example.com/cleanup') {
      if (state.rejectSubmit) return json({ error: '邮箱数据或清理状态已变化，请重新预览。' }, 409)
      expect(request.postDataJSON()).toEqual({ jobId, confirmDomain: 'example.com' })
      state.submitted = true
      return json({ jobId, status: state.status }, 202)
    }
    if (path === `/api/admin/domain-cleanup-jobs/${jobId}`) {
      if (state.status === 'completed') state.present = false
      return json({ job: { id: jobId, domain: 'example.com', mode: 'selected', status: state.status, summary, error: state.status === 'failed' ? '清理未完成，请重试；已完成的数据不会恢复。' : '', total: 2, completed: state.status === 'completed' ? 2 : 0, objectsPending: 0 } })
    }
    if (path === `/api/admin/domain-cleanup-jobs/${jobId}/retry`) {
      state.status = 'running'
      state.retries++
      return json({ jobId, status: state.status }, 202)
    }
    return json({ error: 'Not mocked' }, 404)
  })
  await page.goto('/admin/settings')
  await expect(page.getByRole('heading', { name: '域名管理', exact: true })).toBeVisible()
  return state
}

test('移除配置明确保留数据，并调用兼容接口的显式模式', async ({ page }) => {
  const state = await setup(page)
  await page.getByRole('button', { name: '移除配置', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('保留 2 个邮箱')
  await expect(dialog).toContainText('停止该域名的新收发')
  await dialog.getByRole('button', { name: '移除域名配置', exact: true }).click()
  await expect.poll(() => state.removeMode).toBe('configuration')
  await expect(page.locator('.managed-domain-row')).toHaveCount(0)
})

test('关联列表展示其他用户；主邮箱保护和窄屏布局有效', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page, 'super_admin', true)
  await page.getByRole('button', { name: /查看关联邮箱/ }).click()
  const panel = page.getByRole('region', { name: 'example.com 的关联邮箱' })
  await expect(panel).toContainText('other@example.net')
  await expect(panel.getByRole('checkbox', { name: '选择邮箱：owner@example.com' })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '清理全部关联邮箱并移除配置' })).toBeDisabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await panel.screenshot({ path: testInfo.outputPath('domain-mailboxes-mobile.png') })
})

test('选中清理需要输入完整域名，确认框键盘焦点包含输入框', async ({ page }, testInfo) => {
  const state = await setup(page)
  await page.getByRole('button', { name: /查看关联邮箱/ }).click()
  await page.getByRole('checkbox', { name: '选择邮箱：alias@example.com' }).check()
  await page.getByRole('button', { name: '清理选中邮箱（1）' }).click()
  const dialog = page.getByRole('alertdialog')
  const input = dialog.getByRole('textbox', { name: '输入域名 example.com 确认' })
  await expect(input).toBeFocused()
  await expect(input).toHaveAttribute('inputmode', 'text')
  await dialog.screenshot({ path: testInfo.outputPath('domain-cleanup-confirmation.png') })
  await expect(dialog.getByRole('button', { name: '提交清理任务' })).toBeDisabled()
  await input.fill('example.com')
  await input.press('Tab')
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(input).toBeFocused()
  await dialog.getByRole('button', { name: '提交清理任务' }).click()
  await expect.poll(() => state.previewBody).toEqual({ mode: 'selected', addresses: ['alias@example.com'] })
  await expect(page.getByText('等待后台清理', { exact: true })).toBeVisible()
})

test('刷新恢复失败任务，重试恢复进度，完成后刷新域名列表', async ({ page }) => {
  const state = await setup(page)
  state.submitted = true
  state.status = 'failed'
  await page.reload()
  await page.getByRole('button', { name: /查看关联邮箱/ }).click()
  await expect(page.getByText('清理未完成', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重试清理任务' }).click()
  await expect.poll(() => state.retries).toBe(1)
  await expect(page.getByText('正在清理', { exact: true }).last()).toBeVisible()
  state.status = 'completed'
  await expect(page.getByText('清理完成', { exact: true })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.managed-domain-row')).toHaveCount(0)
})

test('普通管理员可以查看关联记录，不能使用批量清理入口', async ({ page }) => {
  await setup(page, 'admin')
  await page.getByRole('button', { name: /查看关联邮箱/ }).click()
  await expect(page.getByText('other@example.net', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '清理全部关联邮箱并移除配置' })).toHaveCount(0)
})

test('提交冲突在确认框内显示，用户可以取消并重新预览', async ({ page }) => {
  const state = await setup(page)
  state.rejectSubmit = true
  await page.getByRole('button', { name: /查看关联邮箱/ }).click()
  await page.getByRole('checkbox', { name: '选择邮箱：alias@example.com' }).check()
  await page.getByRole('button', { name: '清理选中邮箱（1）' }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('textbox').fill('example.com')
  await dialog.getByRole('button', { name: '提交清理任务' }).click()
  await expect(dialog.getByRole('alert')).toContainText('请重新预览')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(state.submitted).toBe(false)
})
