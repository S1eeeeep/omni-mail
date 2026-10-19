import type { Env } from '../../app/types'
import { mailCredentialCipher } from '../../shared/security/mail-credentials'

const credentials = mailCredentialCipher('MICROSOFT_CREDENTIALS_KEY', 'Microsoft')

export const microsoftCredentialsReady = credentials.ready
export const encryptMicrosoftCredential = credentials.encrypt
export const decryptMicrosoftCredential = credentials.decrypt

export function microsoftMailEnabled(env: Env): boolean {
  return env.MICROSOFT_MAIL_ENABLED !== 'false' && microsoftCredentialsReady(env)
}

export function microsoftCredentialContext(
  userId: string,
  accountId: string,
  kind: 'refresh-token' | 'access-token' | 'password' | 'combination-password',
): string {
  return `${userId}:${accountId}:${kind}`
}
