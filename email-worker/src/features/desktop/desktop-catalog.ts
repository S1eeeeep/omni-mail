import type { Env, SessionUser } from '../../app/types'
import { mailCredentialsReady } from '../../shared/security/mail-credentials'

export interface DesktopAccount {
  id: string
  provider: string
  email: string
  name: string
  ready: boolean
  note: string
}

type Row = Omit<DesktopAccount, 'ready' | 'note'> & { available: number }

// 只读元数据，列表请求不解密邮箱凭据；SQL 片段全部来自固定目录。
const sources = [
  {
    provider: 'omnimail',
    table: 'mailboxes',
    id: 'address',
    email: 'address',
    name: "'域名邮箱'",
    ready: 'is_active',
    extra: 'AND is_hidden = 0',
  },
  {
    provider: 'gmail',
    table: 'gmail_imap_accounts',
    id: 'id',
    email: 'email',
    name: 'name',
    ready: "app_password_cipher <> ''",
    key: 'GMAIL_CREDENTIALS_KEY',
  },
  {
    provider: 'qq',
    table: 'qq_mail_accounts',
    id: 'id',
    email: 'email',
    name: 'name',
    ready: "authorization_code_cipher <> ''",
    key: 'QQ_MAIL_CREDENTIALS_KEY',
  },
  {
    provider: 'naver',
    table: 'naver_mail_accounts',
    id: 'id',
    email: 'email',
    name: 'name',
    ready: "app_password_cipher <> ''",
    key: 'NAVER_MAIL_CREDENTIALS_KEY',
  },
  {
    provider: 'yandex',
    table: 'yandex_mail_accounts',
    id: 'id',
    email: 'email',
    name: 'name',
    ready: "app_password_cipher <> ''",
    key: 'YANDEX_MAIL_CREDENTIALS_KEY',
  },
  {
    provider: 'icloud',
    table: 'icloud_accounts',
    id: 'id',
    email: 'icloud_email',
    name: 'name',
    ready: "app_password_cipher <> '' AND icloud_email <> ''",
    key: 'ICLOUD_CREDENTIALS_KEY',
  },
  {
    provider: 'microsoft',
    table: 'microsoft_imap_accounts',
    id: 'id',
    email: 'normalized_email',
    name: 'name',
    ready: "auth_mode = 'oauth2' AND refresh_token_cipher <> ''",
    key: 'MICROSOFT_CREDENTIALS_KEY',
  },
  {
    provider: 'linuxdo',
    table: 'linux_do_mail_accounts',
    id: 'id',
    email: 'username',
    name: "'LINUX DO'",
    ready: "password_cipher <> ''",
    key: 'LINUX_DO_MAIL_CREDENTIALS_KEY',
  },
] as const

export async function desktopCatalog(env: Env, user: SessionUser): Promise<DesktopAccount[]> {
  const accounts: DesktopAccount[] = []
  for (const source of sources) {
    const { results } = await env.DB.prepare(
      `SELECT ${source.id} AS id, ${source.email} AS email, ${source.name} AS name,
              (${source.ready}) AS available FROM ${source.table}
        WHERE user_id = ? ${'extra' in source ? source.extra : ''} ORDER BY ${source.id} LIMIT 501`,
    )
      .bind(user.id)
      .all<Row>()
    for (const row of results) {
      const keyReady =
        !('key' in source) ||
        mailCredentialsReady(env, source.key)
      const ready = Boolean(row.available) && keyReady
      const email =
        source.provider === 'linuxdo' && !row.email.includes('@')
          ? `${row.email}@linux.do`
          : row.email
      accounts.push({
        id: row.id,
        provider: source.provider,
        email,
        name: row.name,
        ready,
        note: ready
          ? source.provider === 'microsoft'
            ? '沿用原 OAuth 授权，在本机续期'
            : ''
          : source.provider === 'icloud'
            ? '请先在 OmniMail 配置主邮箱及应用专用密码'
            : '凭据未配置、类型不支持或邮箱已停用',
      })
      if (accounts.length > 500) throw new Error('DESKTOP_ACCOUNT_LIMIT')
    }
  }
  return accounts
}
