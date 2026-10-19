import { expect } from '@playwright/test'

export async function verifyDomainKeyboardSelection(page, frame) {
  const combobox = frame.getByRole('combobox', { name: '邮箱域名' })
  // 键盘导航时先移开鼠标，避免菜单重新出现触发悬停；等待活动项和最终选值更新。
  await page.mouse.move(20, 20)
  await combobox.press('ArrowDown')
  await frame.getByRole('listbox', { name: '邮箱域名' }).waitFor()
  await expect(combobox).toHaveAttribute('aria-activedescendant', 'mail-domain-option-0')
  await combobox.press('ArrowDown')
  await expect(combobox).toHaveAttribute('aria-activedescendant', 'mail-domain-option-1')
  await combobox.press('Enter')
  await expect(combobox).toHaveText('@aicnos.com')
}
