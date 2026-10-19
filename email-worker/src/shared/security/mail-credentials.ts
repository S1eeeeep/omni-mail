import type { Env } from '../../app/types'

export type MailCredentialKey =
  | 'ICLOUD_CREDENTIALS_KEY' | 'LINUX_DO_MAIL_CREDENTIALS_KEY' | 'GMAIL_CREDENTIALS_KEY'
  | 'MICROSOFT_CREDENTIALS_KEY' | 'QQ_MAIL_CREDENTIALS_KEY'
  | 'NAVER_MAIL_CREDENTIALS_KEY' | 'YANDEX_MAIL_CREDENTIALS_KEY'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function secret(value: unknown): string {
  const source = typeof value === 'string' ? value.trim() : ''
  return encoder.encode(source).byteLength >= 32 ? source : ''
}

export function globalMailCredentialsReady(env: Env): boolean {
  return Boolean(secret(env.MAIL_CREDENTIALS_KEY))
}

export function legacyMailCredentialsReady(env: Env, name: MailCredentialKey): boolean {
  return Boolean(secret(env[name]))
}

export function mailCredentialsReady(env: Env, name: MailCredentialKey): boolean {
  return globalMailCredentialsReady(env) || legacyMailCredentialsReady(env, name)
}

export async function globalMailKeyId(env: Env): Promise<string | null> {
  const source = secret(env.MAIL_CREDENTIALS_KEY)
  if (!source) return null
  // 独立的域前缀避免暴露旧格式直接用作 AES 密钥的 SHA-256(secret)。
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`omnimail:mail-key-id:v2:${source}`))
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid credential encoding')
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')), (character) => character.charCodeAt(0))
  if (base64Url(bytes) !== value) throw new Error('Invalid credential encoding')
  return bytes
}

async function credentialKey(env: Env, name: MailCredentialKey, global: boolean): Promise<CryptoKey> {
  const source = secret(global ? env.MAIL_CREDENTIALS_KEY : env[name])
  if (!source) throw new Error('Mail credential key is not configured')
  if (!global) {
    // v1 的派生方式及上下文保持原样，确保升级后可以读取历史凭据。
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(source))
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
  }
  const root = await crypto.subtle.importKey('raw', encoder.encode(source), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode('omnimail:mail-credentials:v2'),
    info: encoder.encode(name),
  }, root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function encryptMailCredential(
  env: Env, name: MailCredentialKey, value: string, context: string,
): Promise<string> {
  const keyId = await globalMailKeyId(env)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    await credentialKey(env, name, keyId !== null), encoder.encode(value),
  )
  return `${keyId ? `v2.${keyId}` : 'v1'}.${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`
}

export async function decryptMailCredential(
  env: Env, name: MailCredentialKey, value: string, context: string,
): Promise<string> {
  const parts = value.split('.')
  const global = parts[0] === 'v2'
  if (global ? parts.length !== 4 || parts[1] !== await globalMailKeyId(env)
    : parts[0] !== 'v1' || parts.length !== 3) throw new Error('Invalid encrypted credential')
  const iv = base64UrlBytes(parts[global ? 2 : 1])
  const ciphertext = base64UrlBytes(parts[global ? 3 : 2])
  if (iv.byteLength !== 12 || ciphertext.byteLength < 16) throw new Error('Invalid encrypted credential')
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    await credentialKey(env, name, global), ciphertext,
  )
  return decoder.decode(decrypted)
}

export function mailCredentialCipher(name: MailCredentialKey, label: string, allowEmpty = false) {
  return {
    ready: (env: Env) => mailCredentialsReady(env, name),
    encrypt: async (env: Env, value: string, context: string): Promise<string> => {
      if (allowEmpty && !value) return ''
      return encryptMailCredential(env, name, value, context)
    },
    decrypt: async (env: Env, value: string, context: string): Promise<string> => {
      if (allowEmpty && !value) return ''
      try {
        return await decryptMailCredential(env, name, value, context)
      } catch {
        // 不把密钥、密文、上下文或底层异常回传到 API 与日志。
        throw new Error(`Unable to decrypt ${label} credentials`)
      }
    },
  }
}
