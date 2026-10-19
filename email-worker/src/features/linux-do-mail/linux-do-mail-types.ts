import type { ICloudMessage } from '../icloud/icloud-types'

export type LinuxDoMailAccountStatus = 'active' | 'error'

export interface LinuxDoMailAccount {
  id: string
  userId: string
  username: string
  password: string
  status: LinuxDoMailAccountStatus
  lastValidated: string
  lastError: string
  createdAt: string
}

export interface LinuxDoMailAccountRow {
  id: string
  user_id: string
  username: string
  password_cipher: string
  status: LinuxDoMailAccountStatus
  last_validated: string
  last_error: string
  created_at: string
}

export type PublicLinuxDoMailAccount = Omit<
  LinuxDoMailAccount,
  'userId' | 'password'
> & { hasPassword: boolean }

export type LinuxDoMailMessage = ICloudMessage

export function isLinuxDoMailMessageUid(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 10) return false
  const uid = Number(value)
  // 仅允许规范的 32 位正整数，防止控制字符或 UID 序列进入 IMAP 读写命令。
  return Number.isInteger(uid) && uid > 0 && uid <= 0xffff_ffff && String(uid) === value
}
