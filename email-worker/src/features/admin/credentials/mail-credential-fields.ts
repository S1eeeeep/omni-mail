import type { MailCredentialKey } from '../../../shared/security/mail-credentials'

export interface MailCredentialField {
  provider: string
  table: string
  column: string
  purpose: string
  key: MailCredentialKey
}

// 迁移必须覆盖未启用账号及备用字段；这些标识符只来自固定目录，不接受请求输入。
export const mailCredentialFields: readonly MailCredentialField[] = [
  { provider: 'iCloud', table: 'icloud_accounts', column: 'cookies_cipher', purpose: 'cookies', key: 'ICLOUD_CREDENTIALS_KEY' },
  { provider: 'iCloud', table: 'icloud_accounts', column: 'app_password_cipher', purpose: 'app-password', key: 'ICLOUD_CREDENTIALS_KEY' },
  { provider: 'Linux DO Mail', table: 'linux_do_mail_accounts', column: 'password_cipher', purpose: 'password', key: 'LINUX_DO_MAIL_CREDENTIALS_KEY' },
  { provider: 'Gmail', table: 'gmail_imap_accounts', column: 'app_password_cipher', purpose: 'app-password', key: 'GMAIL_CREDENTIALS_KEY' },
  { provider: 'Microsoft', table: 'microsoft_imap_accounts', column: 'refresh_token_cipher', purpose: 'refresh-token', key: 'MICROSOFT_CREDENTIALS_KEY' },
  { provider: 'Microsoft', table: 'microsoft_imap_accounts', column: 'access_token_cipher', purpose: 'access-token', key: 'MICROSOFT_CREDENTIALS_KEY' },
  { provider: 'Microsoft', table: 'microsoft_imap_accounts', column: 'password_cipher', purpose: 'password', key: 'MICROSOFT_CREDENTIALS_KEY' },
  { provider: 'Microsoft', table: 'microsoft_imap_accounts', column: 'combination_password_cipher', purpose: 'combination-password', key: 'MICROSOFT_CREDENTIALS_KEY' },
  { provider: 'QQ Mail', table: 'qq_mail_accounts', column: 'authorization_code_cipher', purpose: 'qq-authorization-code', key: 'QQ_MAIL_CREDENTIALS_KEY' },
  { provider: 'NAVER Mail', table: 'naver_mail_accounts', column: 'app_password_cipher', purpose: 'naver-app-password', key: 'NAVER_MAIL_CREDENTIALS_KEY' },
  { provider: 'Yandex Mail', table: 'yandex_mail_accounts', column: 'app_password_cipher', purpose: 'yandex-app-password', key: 'YANDEX_MAIL_CREDENTIALS_KEY' },
]
