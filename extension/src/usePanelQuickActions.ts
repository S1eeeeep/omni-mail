import { t } from '../../src/shared/i18n'
import { sendExtensionMessage } from './protocol'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。'
}

async function writeClipboardText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    return
  } catch {
    const input = document.createElement('textarea')
    input.value = value
    input.setAttribute('readonly', '')
    input.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.append(input)
    input.select()
    const copied = document.execCommand('copy')
    input.remove()
    if (!copied) throw new Error('copy failed')
  }
}

export function usePanelQuickActions({ onNotice, onError }: {
  onNotice: (message: string) => void
  onError: (message: string) => void
}) {
  async function copy(value: string, success: string) {
    onError('')
    try {
      await writeClipboardText(value)
      onNotice(t(success))
    } catch {
      onError(t('无法访问剪贴板，请手动复制。'))
    }
  }

  async function fill(request: Parameters<typeof sendExtensionMessage>[0], success: string) {
    onError('')
    try {
      await sendExtensionMessage(request)
      onNotice(t(success))
    } catch (error) {
      onError(errorText(error))
    }
  }

  return {
    copyAddress: (address: string) => copy(address, '邮箱地址已复制'),
    copyVerificationCode: (code: string) => copy(code, '验证码已复制'),
    fillAddress: (address: string) => fill(
      { type: 'page:fill-email', email: address }, '已填入当前网页',
    ),
    fillVerificationCode: (code: string) => fill(
      { type: 'page:fill-verification-code', code }, '验证码已填入当前网页',
    ),
  }
}
