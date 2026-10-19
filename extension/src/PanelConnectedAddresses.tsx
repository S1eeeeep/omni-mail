import { Copy, SendToBack } from 'lucide-react'
import { t, useLocale } from '../../src/shared/i18n'
import type { MailSourceDescriptor } from './mail-source'

interface Props {
  onCopy: (address: string) => void
  onFill: (address: string) => void
  source: MailSourceDescriptor
}

function statusLabel(account: MailSourceDescriptor['accounts'][number]): string {
  if (account.needsAttention) return t('需要在网页端修复')
  if (account.status === 'syncing') return t('正在同步')
  return t('可用')
}

export function PanelConnectedAddresses({ onCopy, onFill, source }: Props) {
  useLocale()
  const sourceLabel = t(source.label)

  return (
    <section className="page-card connected-addresses-card"
      aria-label={t('使用已连接的 {source} 邮箱', { source: sourceLabel })}>
      <div className="connected-addresses-heading">
        <div>
          <strong>{t('使用已连接的 {source} 邮箱', { source: sourceLabel })}</strong>
          <span>{t('选择一个地址即可复制或填入当前网页')}</span>
        </div>
      </div>
      <div className="connected-address-list">
        {source.accounts.map((account) => {
          const address = account.email.trim()
          const sourceAccountLabel = `${sourceLabel} · ${account.name}`
          return (
            <div className="connected-address-row" role="group"
              aria-label={address ? `${sourceAccountLabel} · ${address}` : sourceAccountLabel}
              key={`${source.id}:${account.id}`}>
              <div className="connected-address-copy">
                <span>{sourceLabel}</span>
                <strong title={address || undefined}>{address || t('暂无可用邮箱地址')}</strong>
                <small>{account.name} · {statusLabel(account)}</small>
              </div>
              {address ? <div className="connected-address-actions">
                <button type="button" onClick={() => onCopy(address)}>
                  <Copy size={14} aria-hidden="true" />{t('复制')}
                </button>
                <button type="button" onClick={() => onFill(address)}>
                  <SendToBack size={14} aria-hidden="true" />{t('填入网页')}
                </button>
              </div> : <span className="connected-address-unavailable">{t('请先在网页端配置账号')}</span>}
            </div>
          )
        })}
      </div>
    </section>
  )
}
