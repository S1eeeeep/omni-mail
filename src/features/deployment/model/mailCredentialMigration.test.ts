import { describe, expect, it } from 'vitest'
import { validMigrationStatus } from './mailCredentialMigration'

const status = { globalKeyConfigured: false, globalKeyReady: false, keyId: null,
  total: 1, migrated: 0, pending: 1,
  providers: [{ provider: 'Gmail', total: 1, migrated: 0, pending: 1, legacyKeyReady: true }],
}

describe('迁移状态响应校验', () => {
  it('接受有效的旧配置及迁移进度', () => {
    expect(validMigrationStatus(status)).toBe(true)
    expect(validMigrationStatus({ ...status, globalKeyConfigured: true, globalKeyReady: true, keyId: 'a'.repeat(32) })).toBe(true)
  })
  it.each([null, {}, [], { error: 'old server' }, { ...status, providers: undefined },
    { ...status, pending: -1 }, { ...status, total: 10 }, { ...status, globalKeyReady: true },
    { ...status, providers: [null] }, { ...status, providers: Array(8).fill(status.providers[0]) },
  ])('拒绝异常响应，避免可选引导影响主页面：%j', (value) => {
    expect(validMigrationStatus(value)).toBe(false)
  })
})
