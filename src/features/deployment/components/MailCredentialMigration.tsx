import { Check, ExternalLink, KeyRound, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../../../shared/i18n'
import { errorMessage } from '../../../shared/api/errorMessage'
import { mailCredentialMigration, type MailCredentialMigrationStatus, type MigrationCursor } from '../model/mailCredentialMigration'
import '../styles/deployment-wizard.css'
import '../styles/deployment-wizard-responsive.css'
import '../styles/mail-credential-migration.css'

export function MailCredentialMigration({ userId, suspended }: { userId: string; suspended: boolean }) {
  const [status, setStatus] = useState<MailCredentialMigrationStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [showIntroduction, setShowIntroduction] = useState(true)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const live = useRef(true)
  const stop = useRef(true)
  const inFlight = useRef(false)
  const titleId = useId()
  const dialog = useRef<HTMLElement>(null)
  const promptKey = `omnimail.mail-key-guide.v1:${userId}:${status?.keyId || 'legacy'}`

  useEffect(() => {
    live.current = true
    mailCredentialMigration.status().then((result) => {
      if (live.current) setStatus(result)
    }).catch(() => undefined)
    return () => { live.current = false; stop.current = true }
  }, [userId])

  const needsMigration = Boolean(status && (status.pending > 0
    || (!status.globalKeyReady && status.providers.some((provider) => provider.legacyKeyReady))))
  useEffect(() => {
    if (suspended || !needsMigration) return
    try { if (sessionStorage.getItem(promptKey) === 'dismissed') return } catch { /* 隐私模式下仅影响提示记忆。 */ }
    setOpen(true)
  }, [needsMigration, promptKey, suspended])

  const close = useCallback(() => {
    stop.current = true
    setRunning(false)
    setOpen(false)
    try { sessionStorage.setItem(promptKey, 'dismissed') } catch { /* 不阻断正常使用。 */ }
  }, [promptKey])

  useEffect(() => {
    if (!open || suspended) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus())
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key !== 'Tab') return
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')
      if (!controls?.length) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [open, suspended, close])

  async function refresh() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await mailCredentialMigration.status()
      if (live.current) setStatus(result)
    } catch (failure) { if (live.current) setError(errorMessage(failure)) }
    finally { inFlight.current = false; if (live.current) setBusy(false) }
  }

  async function start() {
    if (inFlight.current || !status?.keyId) return
    inFlight.current = true
    stop.current = false
    setBusy(true); setRunning(true); setError(''); setMessage('')
    let cursor: MigrationCursor | null = null
    try {
      do {
        const result = await mailCredentialMigration.batch(status.keyId, cursor)
        if (!live.current) return
        setStatus(result.status)
        cursor = result.cursor
        if (!cursor && result.status.pending > 0) {
          setError(t('仍有凭据未迁移。请检查对应旧密钥是否保留；修复后可继续迁移，原数据未被覆盖。'))
        }
      } while (cursor && !stop.current)
      if (stop.current && live.current) setMessage(t('已暂停。当前批次已结束，可随时继续。'))
    } catch (failure) { if (live.current) setError(errorMessage(failure)) }
    finally {
      inFlight.current = false
      if (live.current) { setBusy(false); setRunning(false) }
    }
  }

  if (!status) return null
  const complete = status.globalKeyReady && status.pending === 0
  const introduction = showIntroduction && status.migrated === 0
  return <>
    {needsMigration && <div className="mail-key-notice">
      <KeyRound size={17} aria-hidden="true" />
      <span>{t('邮箱加密密钥可以统一管理')}</span>
      <button type="button" onClick={() => setOpen(true)}>{t('设置与迁移')}</button>
    </div>}
    {open && !suspended && createPortal(<div className="deployment-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close()
    }}>
      <section ref={dialog} className={`deployment-dialog mail-key-dialog${introduction ? ' mail-key-dialog--intro' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="deployment-dialog__header">
          <span className="deployment-dialog__symbol"><KeyRound size={24} aria-hidden="true" /></span>
          <div>
            {introduction && <p className="eyebrow">{t('升级说明')}</p>}
            <h2 id={titleId} tabIndex={-1}>{introduction ? t('建议切换到全局密钥') : t('统一邮箱加密密钥')}</h2>
            {!introduction && <p>{t('仅主管理员可见，原有独立密钥配置仍可继续使用。')}</p>}
          </div>
          <button type="button" className="icon-button" data-autofocus onClick={close} aria-label={t('关闭')}><X size={18} /></button>
        </header>
        {introduction ? <>
          <div className="mail-key-body mail-key-intro">
            <p className="mail-key-intro__lead">{t('OmniMail 已支持用一份全局密钥统一加密所有邮箱凭据。为方便后续配置和维护，建议已部署用户尽快完成切换。')}</p>
            <ul className="mail-key-benefits">
              <li><Check size={18} aria-hidden="true" /><div><strong>{t('只需维护一份密钥')}</strong><p>{t('统一管理各邮箱的加密配置，减少重复设置和备份。')}</p></div></li>
              <li><Check size={18} aria-hidden="true" /><div><strong>{t('接入新邮箱更省心')}</strong><p>{t('后续接入其他邮箱服务时，无需再单独新增加密密钥。')}</p></div></li>
              <li><Check size={18} aria-hidden="true" /><div><strong>{t('保留已有邮箱绑定')}</strong><p>{t('按向导迁移已保存的凭据，无需重新绑定账号，并可随时暂停后继续。')}</p></div></li>
            </ul>
            <p className="mail-key-help">{t('现有独立密钥仍然兼容。你可以稍后处理，准备好后从首页的“设置与迁移”继续。')}</p>
          </div>
          <footer className="deployment-dialog__footer">
            <button type="button" className="button button--secondary" onClick={close}>{t('稍后处理')}</button>
            <button type="button" className="button button--primary" onClick={() => {
              setShowIntroduction(false)
              requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('h2')?.focus())
            }}>{t('开始设置')}</button>
          </footer>
        </> : <><div className="mail-key-body">
          <ol className="mail-key-steps" aria-label={t('迁移步骤')}>
            <li aria-current={!status.globalKeyReady ? 'step' : undefined}>{t('1. 配置全局密钥')}</li>
            <li aria-current={status.globalKeyReady && !complete ? 'step' : undefined}>{t('2. 迁移已有凭据')}</li>
            <li aria-current={complete ? 'step' : undefined}>{t('3. 确认完成')}</li>
          </ol>
          {!status.globalKeyReady ? <>
            <p>{t('在 Cloudflare 中打开当前 Worker → Settings → Variables and Secrets，新增 Secret：')}</p>
            <code className="mail-key-name">MAIL_CREDENTIALS_KEY</code>
            <p>{t('使用至少 32 字节的随机密钥，保存并部署后，回到此处检查配置。已有密钥请先保留。')}</p>
            {status.globalKeyConfigured && <p className="list-error" role="alert">{t('已检测到全局密钥，但长度不足，请检查配置。')}</p>}
            <a className="button button--secondary" href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">
              {t('打开 Cloudflare')}<ExternalLink size={15} aria-hidden="true" />
            </a>
          </> : <>
            <p className="mail-key-ready"><Check size={17} aria-hidden="true" />{t('全局密钥已就绪')}</p>
            <p>{complete ? t('当前凭据已全部使用全局密钥。') : t('点击开始后逐批迁移，邮箱可继续使用，无需重新绑定账号。')}</p>
          </>}
          <div className="mail-key-progress">
            <label htmlFor={`${titleId}-progress`}>{t('已统一 {migrated} / {total} 项凭据', { migrated: status.migrated, total: status.total })}</label>
            <progress id={`${titleId}-progress`} value={status.total ? status.migrated : complete ? 1 : 0} max={status.total || 1} />
            <span role="status" aria-live="polite">{running ? t('迁移中，请保持此页面打开。') : message || (complete ? t('迁移完成') : t('迁移仅在你点击开始后运行。'))}</span>
          </div>
          <ul className="mail-key-providers">
            {status.providers.filter((provider) => provider.total > 0).map((provider) => <li key={provider.provider}>
              <span>{provider.provider}</span>
              <span>{t('{count} 项待迁移', { count: provider.pending })}{provider.pending > 0 && !provider.legacyKeyReady && <small>{t('请确认旧密钥仍然可用')}</small>}</span>
            </li>)}
          </ul>
          {error && <p className="list-error" role="alert">{error}</p>}
          <p className="mail-key-help">{complete
            ? t('确认全部运行实例均已升级后，可删除旧 Secret。历史备份仍需对应旧密钥，请离线妥善保留。')
            : t('关闭或暂停后，当前批次可能完成，但不会继续下一批。已完成的迁移会保留；下次从剩余凭据继续。')}</p>
          <p className="mail-key-help">{t('开始使用全局密钥后请勿随意更换或删除它，也不要回滚到不支持此格式的旧版本。')}</p>
        </div>
        <footer className="deployment-dialog__footer">
          <button type="button" className="button button--secondary" onClick={close}>{complete ? t('完成') : t('暂不迁移')}</button>
          <div className="mail-key-actions">
            <button type="button" className="button button--secondary" disabled={busy} onClick={() => void refresh()}>{t('重新检查配置')}</button>
            {running ? <button type="button" className="button" onClick={() => { stop.current = true; setRunning(false); setMessage(t('正在结束当前批次…')) }}>{t('暂停迁移')}</button>
              : !complete && <button type="button" className="button button--primary" disabled={busy || !status.globalKeyReady} onClick={() => void start()}>{busy ? t('请稍候…') : t('开始 / 继续迁移')}</button>}
          </div>
        </footer></>}
      </section>
    </div>, document.body)}
  </>
}
