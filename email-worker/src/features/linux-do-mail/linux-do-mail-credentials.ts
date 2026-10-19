import { mailCredentialCipher } from '../../shared/security/mail-credentials'

const credentials = mailCredentialCipher('LINUX_DO_MAIL_CREDENTIALS_KEY', 'Linux DO Mail')

export const linuxDoMailCredentialsReady = credentials.ready
export const encryptLinuxDoMailCredential = credentials.encrypt
export const decryptLinuxDoMailCredential = credentials.decrypt
