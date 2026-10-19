import { mailCredentialCipher } from '../../shared/security/mail-credentials'

const credentials = mailCredentialCipher('YANDEX_MAIL_CREDENTIALS_KEY', 'Yandex Mail')

export const yandexMailCredentialsReady = credentials.ready
export const encryptYandexMailCredential = credentials.encrypt
export const decryptYandexMailCredential = credentials.decrypt

export const yandexMailImapEnabled = yandexMailCredentialsReady
