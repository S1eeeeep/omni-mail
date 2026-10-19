import { Copy, SendToBack } from 'lucide-react'
import { t, useLocale } from '../../src/shared/i18n'

export function PanelVerificationCode({ code, onCopy, onFill }: {
  code: string
  onCopy: (code: string) => void
  onFill: (code: string) => void
}) {
  useLocale()
  if (!code) return null
  return (
    <div className="verification-code-bar" role="group"
      aria-label={t('识别到验证码 {code}', { code })}>
      <span><small>{t('验证码')}</small><strong>{code}</strong></span>
      <div>
        <button type="button" aria-label={t('复制验证码 {code}', { code })}
          onClick={() => onCopy(code)}><Copy size={13} aria-hidden="true" />{t('复制')}</button>
        <button type="button" aria-label={t('填入验证码 {code}', { code })}
          onClick={() => onFill(code)}><SendToBack size={13} aria-hidden="true" />{t('填入')}</button>
      </div>
    </div>
  )
}
