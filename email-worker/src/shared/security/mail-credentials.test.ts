import { describe, expect, it } from 'vitest'
import type { Env } from '../../app/types'
import { decryptMailCredential, encryptMailCredential, globalMailKeyId, mailCredentialsReady } from './mail-credentials'
import { mailCredentialFields } from '../../features/admin/credentials/mail-credential-fields'
import { decryptGmailCredential, encryptGmailCredential, gmailImapEnabled } from '../../features/gmail/gmail-credentials'
import { naverMailImapEnabled } from '../../features/naver-mail/naver-mail-credentials'
import { yandexMailImapEnabled } from '../../features/yandex-mail/yandex-mail-credentials'
import { encryptICloudCredential, decryptICloudCredential } from '../../features/icloud/icloud-credentials'

const global = { MAIL_CREDENTIALS_KEY: 'global-test-secret-with-at-least-32-bytes' } as Env
const context = 'user-1:account-1:app-password'

describe('统一邮箱密钥兼容性', () => {
  it.each(mailCredentialFields)('$provider / $column 同时支持新旧密文，删除旧密钥后仍能读取已迁移数据', async ({ key }) => {
    const legacy = { [key]: `legacy-test-secret-for-${key}-at-least-32-bytes` } as unknown as Env
    const mixed = { ...legacy, ...global }
    const old = await encryptMailCredential(legacy, key, 'old-test-password', context)
    expect(old).toMatch(/^v1\./)
    expect(mailCredentialsReady(global, key)).toBe(true)
    await expect(decryptMailCredential(mixed, key, old, context)).resolves.toBe('old-test-password')
    const current = await encryptMailCredential(mixed, key, 'new-test-password', context)
    expect(current).toMatch(/^v2\.[a-f0-9]{32}\./)
    await expect(decryptMailCredential(global, key, current, context)).resolves.toBe('new-test-password')
    await expect(decryptMailCredential(global, key, old, context)).rejects.toThrow()
    await expect(decryptMailCredential(legacy, key, current, context)).rejects.toThrow()
  })

  it('读取升级前的 SHA-256 + AES-GCM 密文，与新版写入逻辑独立验证', async () => {
    const oldSecret = 'legacy-test-key-material-more-than-32-bytes'
    const bytes = new TextEncoder()
    const rawKey = await crypto.subtle.digest('SHA-256', bytes.encode(oldSecret))
    const oldKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt'])
    const iv = Uint8Array.from({ length: 12 }, (_, i) => i)
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bytes.encode(context) }, oldKey, bytes.encode('pre-upgrade-password'))
    const encode = (value: Uint8Array) => Buffer.from(value).toString('base64url')
    const fixture = `v1.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`
    await expect(decryptGmailCredential({ ...global, GMAIL_CREDENTIALS_KEY: oldSecret }, fixture, context)).resolves.toBe('pre-upgrade-password')
  })

  it('统一主密钥仍隔离提供商、用户和字段，拒绝篡改及错误密钥', async () => {
    const cipher = await encryptGmailCredential(global, 'test-password', context)
    await expect(decryptMailCredential(global, 'NAVER_MAIL_CREDENTIALS_KEY', cipher, context)).rejects.toThrow()
    await expect(decryptGmailCredential(global, cipher, 'user-2:account-1:app-password')).rejects.toThrow('Unable to decrypt')
    await expect(decryptGmailCredential(global, cipher, 'user-1:account-1:cookies')).rejects.toThrow()
    for (const malformed of [cipher + '.extra', cipher.replace('v2.', 'v3.'), cipher.slice(0, -8), 'v2.bad.a.b']) {
      await expect(decryptGmailCredential(global, malformed, context)).rejects.toThrow()
    }
    await expect(decryptGmailCredential({ MAIL_CREDENTIALS_KEY: 'changed-test-secret-with-at-least-32-bytes' } as Env, cipher, context)).rejects.toThrow()
  })

  it('按 UTF-8 字节校验密钥且不改变已有服务开关', async () => {
    expect(mailCredentialsReady({ MAIL_CREDENTIALS_KEY: 'short' } as Env, 'GMAIL_CREDENTIALS_KEY')).toBe(false)
    expect(mailCredentialsReady({ MAIL_CREDENTIALS_KEY: '密'.repeat(11) } as Env, 'GMAIL_CREDENTIALS_KEY')).toBe(true)
    expect(gmailImapEnabled({ ...global, GMAIL_IMAP_ENABLED: 'false' })).toBe(false)
    expect(naverMailImapEnabled(global)).toBe(true)
    expect(yandexMailImapEnabled(global)).toBe(true)
    expect(await globalMailKeyId(global)).toBe(await globalMailKeyId({ ...global, MAIL_CREDENTIALS_KEY: ` ${global.MAIL_CREDENTIALS_KEY} ` }))
    await expect(encryptICloudCredential({} as Env, '', context)).resolves.toBe('')
    await expect(decryptICloudCredential({} as Env, '', context)).resolves.toBe('')
  })
})
