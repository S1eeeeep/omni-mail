import { describe, expect, it, vi } from 'vitest'
import type { Env, SessionUser } from '../../../app/types'
import { getMailCredentialMigration, postMailCredentialMigration } from './mail-credential-api'
import { parseMigrationRequest } from './mail-credential-migration'

const keyId = '0123456789abcdef0123456789abcdef'
const owner = { id: 'owner', role: 'super_admin' } as SessionUser
const request = (body: unknown) => new Request('https://mail.example.com/api/admin/mail-credentials/migration', {
  method: 'POST', body: JSON.stringify(body),
})

describe('主管理员迁移入口', () => {
  it.each(['user', 'admin', 'temporary'])('拒绝 %s 读取进度或迁移', async (role) => {
    const prepare = vi.fn()
    const env = { DB: { prepare } } as unknown as Env
    const user = { ...owner, role } as SessionUser
    expect((await getMailCredentialMigration(env, user, 'cookie')).status).toBe(403)
    expect((await postMailCredentialMigration(env, user, request({}), 'cookie', 'test')).status).toBe(403)
    expect(prepare).not.toHaveBeenCalled()
  })
  it('主管理员设备令牌也不能执行迁移', async () => {
    expect((await getMailCredentialMigration({} as Env, owner, 'bearer')).status).toBe(403)
    expect((await postMailCredentialMigration({} as Env, owner, request({}), 'bearer', '')).status).toBe(403)
  })
  it.each([
    null, [], {}, { keyId }, { keyId, confirm: false }, { keyId, confirm: true, secret: 'should-not-be-accepted' },
    { keyId, confirm: true, cursor: { field: 11, afterId: '' } },
    { keyId, confirm: true, cursor: { field: 0.5, afterId: '' } },
    { keyId, confirm: true, cursor: { field: 0, afterId: 'a'.repeat(255) } },
    { keyId, confirm: true, cursor: { field: 0, afterId: '\n' } },
  ])('拒绝缺少确认或无效游标 %j', (body) => {
    expect(parseMigrationRequest(body)).toBeNull()
  })
  it('只允许有限游标和当前密钥标识，不接收配置 Secret 的值', async () => {
    expect(parseMigrationRequest({ confirm: true, keyId })).toEqual({ keyId, cursor: { field: 0, afterId: '' } })
    const oversized = await postMailCredentialMigration({} as Env, owner, request({ padding: 'x'.repeat(2100) }), 'cookie', '')
    expect(oversized.status).toBe(413)
    const missing = await postMailCredentialMigration({} as Env, owner, request({ confirm: true, keyId }), 'cookie', '')
    expect(missing.status).toBe(409)
    expect(missing.headers.get('Cache-Control')).toContain('no-store')
  })
})
