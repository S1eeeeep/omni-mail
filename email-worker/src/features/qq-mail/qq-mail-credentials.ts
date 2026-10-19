import type { Env } from '../../app/types'
import { mailCredentialCipher } from '../../shared/security/mail-credentials'

const credentials = mailCredentialCipher('QQ_MAIL_CREDENTIALS_KEY', 'QQ Mail')

export const qqMailCredentialsReady = credentials.ready
export const encryptQqMailCredential = credentials.encrypt
export const decryptQqMailCredential = credentials.decrypt

export function qqMailImapEnabled(env: Env): boolean {
  return env.QQ_MAIL_IMAP_ENABLED !== 'false' && qqMailCredentialsReady(env)
}
