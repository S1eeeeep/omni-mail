import { strict as assert } from 'node:assert'

export async function verifyNotificationSettings(page, frame, serviceWorker, addGmailNotification) {
  const notifications = frame.getByRole('checkbox', { name: '新邮件通知' })
  await notifications.uncheck()
  await page.waitForTimeout(100)
  assert.equal((await serviceWorker.evaluate(() => (
    chrome.storage.local.get('notificationsEnabled')
  ))).notificationsEnabled, false)
  await notifications.check()
  const gmailNotifications = frame.getByRole('checkbox', { name: 'Gmail' })
  await gmailNotifications.uncheck()
  await page.waitForTimeout(100)
  assert.equal((await serviceWorker.evaluate(() => (
    chrome.storage.local.get('notificationSources')
  ))).notificationSources.includes('gmail'), false)
  await gmailNotifications.check()
  assert.equal(await frame.getByLabel('开始').inputValue(), '22:00')
  assert.equal(await frame.getByLabel('结束').inputValue(), '07:00')
  const quietHoursEnabled = frame.getByRole('checkbox', { name: '启用勿扰时段' })
  assert.equal(await quietHoursEnabled.isChecked(), false)
  await quietHoursEnabled.check()
  await frame.getByLabel('开始').fill('23:00')
  await frame.getByLabel('结束').fill('08:00')
  await page.waitForTimeout(100)
  const quietHours = await serviceWorker.evaluate(() => chrome.storage.local.get([
    'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd',
  ]))
  assert.deepEqual(quietHours, {
    quietHoursEnabled: true, quietHoursStart: '23:00', quietHoursEnd: '08:00',
  })
  await quietHoursEnabled.uncheck()
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.remove(['knownMessageKeys', 'knownNotificationSources'])
    await chrome.alarms.create('omnimail-mail-poll', { when: Date.now() + 100 })
  })
  await page.waitForTimeout(1_500)
  assert.equal(Object.keys(await serviceWorker.evaluate(() => chrome.notifications.getAll())).length, 0)
  addGmailNotification()
  await serviceWorker.evaluate(() => chrome.alarms.create(
    'omnimail-mail-poll', { when: Date.now() + 100 },
  ))
  await page.waitForTimeout(1_500)
  const notificationIds = Object.keys(await serviceWorker.evaluate(() => chrome.notifications.getAll()))
  assert.equal(notificationIds.length, 1)
  assert.match(notificationIds[0], /^float:/)
  const targets = await serviceWorker.evaluate(() => chrome.storage.local.get('notificationTargets'))
  assert.match(targets.notificationTargets[notificationIds[0]], /^\/gmail\?/)
}
