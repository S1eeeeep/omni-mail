import { validEmail } from '../../shared/http/api-helpers'
import { GmailStoreError } from './gmail-store'

// Google 应用密码页展示的 `abcd efgh ijkl mnop` 分组格式里，分隔符并不总是普通空格
// （U+0020）：不间断空格（U+00A0）、窄不间断空格（U+202F）和零宽空格（U+200B）都会随
// 复制粘贴一起进入输入框，只移除普通空格会让看起来完全正常的粘贴值校验失败。这里按
// Unicode 空格分隔符与零宽格式字符统一剥离；制表符、换行等控件字符仍然判为无效，避免
// 把 Google 账号主密码或其他内容误当成应用专用密码。
const APP_PASSWORD_SEPARATORS =
  /[\u0020\u00A0\u1680\u180E\u2000-\u200F\u202F\u205F\u2060\u3000\uFEFF]/g

export function gmailNameField(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 60 || /[\r\n\0]/.test(name)) {
    throw new GmailStoreError(400, '账号名称需要为 1–60 个字符。')
  }
  return name
}

export function gmailEmailField(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!validEmail(email) || /[\r\n\0]/.test(email)) {
    throw new GmailStoreError(400, '请填写完整的 Gmail 或 Google Workspace 邮箱地址。')
  }
  return email
}

export function gmailAppPasswordField(value: unknown): string {
  const password = typeof value === 'string'
    ? value.replace(APP_PASSWORD_SEPARATORS, '')
    : ''
  if (!/^[\x21-\x7E]{16}$/.test(password) || /[\r\n\0]/.test(password)) {
    throw new GmailStoreError(400, '请填写 Google 生成的 16 位应用专用密码，而不是账号主密码。')
  }
  return password
}
