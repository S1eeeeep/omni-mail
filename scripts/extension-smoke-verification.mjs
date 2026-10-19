import { strict as assert } from 'node:assert'

export async function verifyCodeActions(page, frame, recentMail) {
  const code = recentMail.getByRole('group', { name: '识别到验证码 123456' })
  await code.getByRole('button', { name: '复制验证码 123456' }).click()
  await frame.getByText('验证码已复制').waitFor()
  await page.evaluate(() => {
    const duplicate = document.createElement('input')
    duplicate.id = 'backup-otp'
    duplicate.autocomplete = 'one-time-code'
    duplicate.style.cssText = 'position:fixed;left:10px;top:10px;width:120px;height:40px'
    document.body.append(duplicate)
  })
  await page.getByLabel('邮箱地址').focus()
  await code.getByRole('button', { name: '填入验证码 123456' }).click()
  await frame.getByText('检测到多个验证码输入框，请先点击要填入的输入框。').waitFor()
  await page.evaluate(() => document.querySelector('#backup-otp')?.remove())
  await page.getByLabel('邮箱地址').focus()
  await code.getByRole('button', { name: '填入验证码 123456' }).click()
  assert.equal(await page.getByLabel('验证码').inputValue(), '123456')
  await frame.getByText('验证码已填入当前网页').waitFor()
}
