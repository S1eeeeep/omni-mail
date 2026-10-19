import type { Env } from '../../app/types'
import { mailCredentialCipher } from '../../shared/security/mail-credentials'

const credentials = mailCredentialCipher('GMAIL_CREDENTIALS_KEY', 'Gmail')

export const gmailCredentialsReady = credentials.ready
export const encryptGmailCredential = credentials.encrypt
export const decryptGmailCredential = credentials.decrypt

export function gmailImapEnabled(env: Env): boolean {
  return env.GMAIL_IMAP_ENABLED !== 'false' && gmailCredentialsReady(env)
}
