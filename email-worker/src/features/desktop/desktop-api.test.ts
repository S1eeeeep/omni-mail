import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, SessionUser } from '../../app/types'
import { exportDesktopCredentials, listDesktopAccounts, parseDesktopSelection } from './desktop-api'

const mock = vi.hoisted(() => ({
  password: vi.fn(),
  mfaEnabled: vi.fn(),
  mfa: vi.fn(),
  catalog: vi.fn(),
  secret: vi.fn(),
  audit: vi.fn(),
}))
vi.mock('../auth/session/password-login', () => ({ authenticatePassword: mock.password }))
vi.mock('../auth/mfa/mfa', () => ({ mfaEnabled: mock.mfaEnabled, verifyMfaForLogin: mock.mfa }))
vi.mock('./desktop-catalog', () => ({ desktopCatalog: mock.catalog }))
vi.mock('./desktop-secrets', () => ({ desktopSecret: mock.secret }))
vi.mock('../../shared/audit/audit', () => ({ writeAudit: mock.audit }))

const env = { DB: {} } as Env
const user = { id: 'owner', email: 'owner@example.com' } as SessionUser
const account = {
  id: 'account-a',
  provider: 'gmail',
  email: 'a@gmail.com',
  name: 'Gmail',
  ready: true,
  note: '',
}
const body = {
  password: 'example-password',
  accounts: [{ id: account.id, provider: account.provider }],
}
const request = (value: unknown) =>
  new Request('https://mail.example.com/api/desktop/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })

beforeEach(() => {
  vi.resetAllMocks()
  mock.password.mockResolvedValue({ user, email: user.email })
  mock.mfaEnabled.mockResolvedValue(false)
  mock.catalog.mockResolvedValue([account])
  mock.secret.mockResolvedValue({ ...account, secret: 'example-app-password' })
})

describe('桌面凭据导入边界', () => {
  it('目录不读取凭据，且所有响应禁止缓存', async () => {
    const response = await listDesktopAccounts(env, user, 'bearer')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(await response.json()).toEqual({ accounts: [account] })
    expect(mock.secret).not.toHaveBeenCalled()
  })
  it('Cookie 会话不能导出密码', async () => {
    expect((await exportDesktopCredentials(env, user, request(body), 'cookie')).status).toBe(403)
    expect(mock.password).not.toHaveBeenCalled()
    expect(mock.secret).not.toHaveBeenCalled()
  })
  it('验证密码对应当前用户后仅解密所选自有账号', async () => {
    const response = await exportDesktopCredentials(env, user, request(body), 'bearer')
    expect(response.status).toBe(200)
    expect(mock.password).toHaveBeenCalledWith(
      env.DB,
      user.email,
      body.password,
      expect.any(String),
    )
    expect(mock.secret).toHaveBeenCalledExactlyOnceWith(env, user.id, account)
    expect(JSON.stringify(mock.audit.mock.calls)).not.toContain('example-app-password')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
  })
  it('密码不匹配时不解密', async () => {
    mock.password.mockResolvedValue({ error: 'invalid', status: 401 })
    expect((await exportDesktopCredentials(env, user, request(body), 'bearer')).status).toBe(401)
    expect(mock.secret).not.toHaveBeenCalled()
  })
  it('二次验证失败时不解密', async () => {
    mock.mfaEnabled.mockResolvedValue(true)
    mock.mfa.mockResolvedValue({ ok: false, rateLimited: true })
    expect((await exportDesktopCredentials(env, user, request(body), 'bearer')).status).toBe(429)
    expect(mock.secret).not.toHaveBeenCalled()
  })
  it('阻止跨用户 ID 和不可导入账户', async () => {
    const response = await exportDesktopCredentials(
      env,
      user,
      request({ ...body, accounts: [{ id: 'other-user-account', provider: 'gmail' }] }),
      'bearer',
    )
    expect(response.status).toBe(403)
    expect(mock.secret).not.toHaveBeenCalled()
  })
  it('拒绝重复、未知服务商和超过 50 个账号', () => {
    for (const value of [
      null,
      [],
      { ...body, accounts: [...body.accounts, ...body.accounts] },
      { ...body, accounts: [{ id: 'a', provider: 'unknown' }] },
      {
        ...body,
        accounts: Array.from({ length: 51 }, (_, i) => ({ id: String(i), provider: 'gmail' })),
      },
    ]) {
      expect(parseDesktopSelection(value)).toBeNull()
    }
  })
  it('在读取凭据前拒绝过大请求体', async () => {
    const response = await exportDesktopCredentials(
      env,
      user,
      request({ ...body, padding: 'x'.repeat(33000) }),
      'bearer',
    )
    expect(response.status).toBe(413)
    expect(mock.password).not.toHaveBeenCalled()
  })
})
