import { describe, expect, it } from 'vitest'
import {
  decryptNaverMailCredential,
  encryptNaverMailCredential,
  naverMailCredentialsReady,
  naverMailImapEnabled,
} from './naver-mail-credentials'
import type { Env } from '../../app/types'

const env = {
  NAVER_MAIL_CREDENTIALS_KEY: 'naver-mail-test-key-that-is-longer-than-thirty-two-bytes',
} as Env

describe('NAVER Mail credential encryption', () => {
  it('uses the dedicated key and binds ciphertext to the account context', async () => {
    const cipher = await encryptNaverMailCredential(
      env,
      'app-password',
      'user-1:naver-mail-1:naver-app-password',
    )

    expect(cipher).toMatch(/^v1\./)
    expect(cipher).not.toContain('app-password')
    await expect(decryptNaverMailCredential(
      env,
      cipher,
      'user-1:naver-mail-1:naver-app-password',
    )).resolves.toBe('app-password')
    await expect(decryptNaverMailCredential(
      env,
      cipher,
      'user-2:naver-mail-1:naver-app-password',
    )).rejects.toThrow('Unable to decrypt')
  })

  it('requires at least 32 UTF-8 bytes', () => {
    expect(naverMailCredentialsReady({ NAVER_MAIL_CREDENTIALS_KEY: 'short' } as Env)).toBe(false)
    expect(naverMailCredentialsReady(env)).toBe(true)
  })

  it('密钥有效即可启用，不再依赖旧环境开关', () => {
    const legacyEnv = { ...env, NAVER_MAIL_IMAP_ENABLED: 'false' }
    expect(naverMailImapEnabled(env)).toBe(true)
    expect(naverMailImapEnabled(legacyEnv)).toBe(true)
    expect(naverMailImapEnabled({} as Env)).toBe(false)
  })
})
