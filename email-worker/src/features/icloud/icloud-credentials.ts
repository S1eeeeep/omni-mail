import { mailCredentialCipher } from '../../shared/security/mail-credentials'

const credentials = mailCredentialCipher('ICLOUD_CREDENTIALS_KEY', 'iCloud', true)

export const iCloudCredentialsReady = credentials.ready
export const encryptICloudCredential = credentials.encrypt
export const decryptICloudCredential = credentials.decrypt
