import { mailCredentialCipher } from '../../shared/security/mail-credentials'

const credentials = mailCredentialCipher('NAVER_MAIL_CREDENTIALS_KEY', 'NAVER Mail')

export const naverMailCredentialsReady = credentials.ready
export const encryptNaverMailCredential = credentials.encrypt
export const decryptNaverMailCredential = credentials.decrypt

export const naverMailImapEnabled = naverMailCredentialsReady
