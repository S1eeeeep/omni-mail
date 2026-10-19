import {
  AlertCircle,
  CheckCircle2,
  Globe2,
  LoaderCircle,
  PauseCircle,
  PlayCircle,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { api, type ManagedDomain } from '../../../shared/api'
import { t } from '../../../shared/i18n'
import { DomainMailboxPanel } from './DomainMailboxPanel'
import { DangerConfirmDialog } from '../../../shared/ui/dialogs/DangerConfirmDialog'

function errorMessage(error: unknown): string {
  return t(error instanceof Error ? error.message : '域名操作失败，请重试。')
}

export function DomainManagement({
  domains,
  onChanged,
  canCleanup,
}: {
  domains: ManagedDomain[]
  onChanged: () => Promise<void>
  canCleanup: boolean
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pendingDelete, setPendingDelete] = useState<ManagedDomain | null>(null)
  const [mailboxDomain, setMailboxDomain] = useState('')

  useEffect(() => {
    if (!error && !notice) return
    const timer = window.setTimeout(() => {
      setError('')
      setNotice('')
    }, error ? 5200 : 3200)
    return () => window.clearTimeout(timer)
  }, [error, notice])

  async function run(key: string, action: () => Promise<void>, success: string): Promise<boolean> {
    setBusy(key)
    setError('')
    setNotice('')
    try {
      await action()
      await onChanged()
      setNotice(success)
      return true
    } catch (actionError) {
      setError(errorMessage(actionError))
      return false
    } finally {
      setBusy('')
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault()
    const nextName = name.trim().toLowerCase()
    if (!nextName) return
    await run(`add:${nextName}`, async () => {
      await api.createDomain(nextName)
      setName('')
    }, t('域名已添加并允许创建邮箱。'))
  }

  async function toggle(domain: ManagedDomain) {
    await run(`toggle:${domain.name}`, async () => {
      await api.updateDomain(domain.name, !domain.isActive)
    }, t(domain.isActive ? '域名已停用，新收发和邮箱创建已停止。' : '域名已重新启用。'))
  }

  async function remove() {
    if (!pendingDelete) return
    const domain = pendingDelete
    const removed = await run(`delete:${domain.name}`, async () => {
      await api.deleteDomain(domain.name, 'configuration')
    }, domain.mailboxCount > 0
      ? t('域名配置已删除，已有邮箱和邮件仍然保留。')
      : t('域名配置已删除。'))
    if (removed) setPendingDelete(null)
  }

  return (
    <section className="admin-card domain-management-card">
      <header>
        <Globe2 size={17} />
        <div>
          <h2>{t('域名管理')}</h2>
          <p>{t('管理域名收发、关联邮箱和历史数据')}</p>
        </div>
      </header>

      <form className="domain-add-form" onSubmit={add}>
        <label htmlFor="managed-domain-name">{t('添加域名')}</label>
        <div className="domain-add-row">
          <div className="domain-add-input">
            <Globe2 size={17} />
            <input
              id="managed-domain-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="example.com"
              autoComplete="off"
              required
            />
          </div>
          <button
            className="button button--primary button--small"
            type="submit"
            disabled={Boolean(busy) || !name.trim()}
          >
            {busy.startsWith('add:')
              ? <LoaderCircle className="spin" size={15} />
              : <Plus size={15} />}
            {t('添加域名')}
          </button>
        </div>
      </form>
      <p className="admin-note">{t('重新添加同名域名后，仍启用的保留邮箱可以恢复收发。')}</p>

      <div className="managed-domain-list">
        {domains.length ? domains.map((domain) => {
          const toggling = busy === `toggle:${domain.name}`
          const deleting = busy === `delete:${domain.name}`
          return (
            <div className="managed-domain-row" key={domain.name}>
              <span className="managed-domain-icon"><Globe2 size={17} /></span>
              <div className="managed-domain-identity">
                <strong>{domain.name}</strong>
                <button className="domain-mailbox-link" type="button" aria-expanded={mailboxDomain === domain.name} onClick={() => setMailboxDomain(mailboxDomain === domain.name ? '' : domain.name)}>
                  {t('{count} 个邮箱地址', { count: domain.mailboxCount })} · {t('查看关联邮箱')}
                </button>
              </div>
              <span className={`domain-state ${domain.isActive ? 'is-active' : ''}`}>
                <span aria-hidden="true" />
                {t(domain.isActive ? '已启用' : '已停用')}
              </span>
              <button
                className="button button--secondary button--small"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void toggle(domain)}
              >
                {toggling
                  ? <LoaderCircle className="spin" size={14} />
                  : domain.isActive ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
                {t(domain.isActive ? '停用' : '启用')}
              </button>
              <button
                className="button button--secondary button--small domain-delete"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => setPendingDelete(domain)}
                data-tooltip={t('删除域名配置')}
              >
                {deleting
                  ? <LoaderCircle className="spin" size={14} />
                  : <Trash2 size={14} />}
                {t('移除配置')}
              </button>
            </div>
          )
        }) : <p className="admin-empty">{t('还没有配置可创建邮箱的域名。')}</p>}
      </div>

      {mailboxDomain && <DomainMailboxPanel key={mailboxDomain} domain={mailboxDomain} canCleanup={canCleanup}
        onChanged={onChanged} onClose={() => setMailboxDomain('')} />}

      <p className="admin-note domain-routing-note">
        {t('添加域名后，仍需要在 Cloudflare Email Routing 中启用该域名，并将 Catch-all 规则指向 OmniMail Worker。')}
      </p>

      {(error || notice) && (
        <button
          className={`domain-toast ${error ? 'is-error' : 'is-success'}`}
          type="button"
          onClick={() => {
            setError('')
            setNotice('')
          }}
          role={error ? 'alert' : 'status'}
        >
          {error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
          <span><strong>{t(error ? '操作没有完成' : '操作成功')}</strong><small>{error || notice}</small></span>
          <X size={15} />
        </button>
      )}

      {pendingDelete && <DangerConfirmDialog
        icon={Trash2}
        eyebrow={t('域名管理')}
        title={t('移除 {domain} 的配置？', { domain: pendingDelete.name })}
        description={t('保留 {count} 个邮箱及其历史邮件、草稿和附件；停止该域名的新收发与邮箱创建，相关邀请失效。Cloudflare DNS 和 Email Routing 需单独管理。', { count: pendingDelete.mailboxCount })}
        impactTitle={t('保留历史数据')}
        impactDescription={t('重新添加同名域名后，仍启用的邮箱可以恢复使用。')}
        confirmLabel={t('移除域名配置')}
        busy={Boolean(busy)}
        error={error}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void remove()}
      />}
    </section>
  )
}
