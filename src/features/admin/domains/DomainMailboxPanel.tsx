import { LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { api, type DomainCleanupJob, type DomainCleanupPreview } from '../../../shared/api'
import { t } from '../../../shared/i18n'
import { DangerConfirmDialog } from '../../../shared/ui/dialogs/DangerConfirmDialog'
import { useDomainMailboxes } from './useDomainMailboxes'

const statusLabels = {
  pending: '等待后台清理', running: '正在清理', waiting_for_objects: '等待附件和对象清理',
  failed: '清理未完成', completed: '清理完成',
} as const

export function DomainMailboxPanel({ domain, canCleanup, onChanged, onClose }: {
  domain: string; canCleanup: boolean; onChanged: () => Promise<void>; onClose: () => void
}) {
  const state = useDomainMailboxes(domain, onChanged)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<DomainCleanupPreview | null>(null)
  const [mode, setMode] = useState<DomainCleanupJob['mode']>('selected')
  const [confirmation, setConfirmation] = useState('')
  const blocked = busy || state.loading || Boolean(state.data?.activeJob)
  const candidates = state.data?.mailboxes.filter((mailbox) => !mailbox.isPrimary && !mailbox.isCleaning) || []

  async function prepare(nextMode: DomainCleanupJob['mode']) {
    setBusy(true)
    state.setError('')
    try {
      const next = await api.previewDomainCleanup(domain, nextMode, selected)
      setMode(nextMode)
      setPreview(next)
      setConfirmation('')
    } catch (error) { state.setError(t(error instanceof Error ? error.message : '清理预览失败。')) }
    finally { setBusy(false) }
  }

  async function submit() {
    if (!preview || confirmation !== domain || busy) return
    setBusy(true)
    state.setError('')
    try {
      const result = await api.submitDomainCleanup(domain, preview.jobId, confirmation)
      state.setJobId(result.jobId)
      setPreview(null)
      setSelected([])
      await state.reload()
      await onChanged()
    } catch (error) { state.setError(t(error instanceof Error ? error.message : '清理任务提交失败。')) }
    finally { setBusy(false) }
  }

  function changePage(cursor?: string) { setSelected([]); void state.reload(cursor) }

  return <section className="domain-mailbox-panel" aria-label={t('{domain} 的关联邮箱', { domain })}>
    <header>
      <div><h3>{t('关联邮箱')} · {domain}</h3>
        {state.data && <p>{t('共 {total} 个，主邮箱 {primary} 个，清理中 {cleaning} 个', {
          total: state.data.totals.total, primary: state.data.totals.primaryCount, cleaning: state.data.totals.cleaningCount,
        })}</p>}
      </div>
      <div className="domain-panel-actions">
        <button className="icon-button" type="button" onClick={() => changePage()} disabled={busy || state.loading} aria-label={t('刷新')}><RefreshCw size={16} /></button>
        <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label={t('关闭')}><X size={16} /></button>
      </div>
    </header>
    {state.error && <p className="inline-error" role="alert">{state.error}</p>}
    {state.loading && <p role="status"><LoaderCircle className="spin" size={16} /> {t('正在加载…')}</p>}
    {state.data && <>
      <div className="domain-mailbox-table-wrap">
        <table className="domain-mailbox-table">
          <thead><tr>
            {canCleanup && <th><input type="checkbox" aria-label={t('选择当前页可清理邮箱')} disabled={blocked || !candidates.length}
              checked={Boolean(candidates.length) && candidates.every((mailbox) => selected.includes(mailbox.address))}
              onChange={(event) => setSelected(event.target.checked ? candidates.map((mailbox) => mailbox.address) : [])} /></th>}
            <th>{t('邮箱地址')}</th><th>{t('所属用户')}</th><th>{t('状态')}</th>
          </tr></thead>
          <tbody>{state.data.mailboxes.map((mailbox) => <tr key={mailbox.address}>
            {canCleanup && <td><input type="checkbox" aria-label={t('选择邮箱：{address}', { address: mailbox.address })}
              disabled={blocked || mailbox.isPrimary || mailbox.isCleaning} checked={selected.includes(mailbox.address)}
              onChange={(event) => setSelected(event.target.checked ? [...selected, mailbox.address] : selected.filter((address) => address !== mailbox.address))} /></td>}
            <td>{mailbox.address}{mailbox.isPrimary && <small>{t('主邮箱 · 请所属用户先迁移')}</small>}</td>
            <td>{mailbox.displayName}<small>{mailbox.userEmail}</small></td>
            <td>{t(mailbox.isCleaning ? '正在清理' : !mailbox.domainActive ? '域名不可用 · 历史可读' : mailbox.isActive ? '已启用' : '已停用')}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {!state.data.mailboxes.length && <p className="admin-empty">{t('没有关联邮箱。')}</p>}
      <div className="domain-panel-actions">
        <button className="button button--secondary button--small" type="button" disabled={busy || state.loading} onClick={() => changePage()}>{t('返回第一页')}</button>
        {state.data.page.hasMore && <button className="button button--secondary button--small" type="button" disabled={busy || state.loading} onClick={() => changePage(state.data!.page.nextCursor!)}>{t('下一页')}</button>}
      </div>
      {canCleanup && <div className="domain-cleanup-actions">
        <p>{t('永久清理会删除目标邮箱的邮件、草稿和附件。主邮箱必须先迁移；备份按保留策略保存。')}</p>
        <div className="domain-panel-actions">
          <button className="button button--secondary button--small" type="button" disabled={blocked || !selected.length} onClick={() => void prepare('selected')}><Trash2 size={14} />{t('清理选中邮箱（{count}）', { count: selected.length })}</button>
          <button className="button button--secondary button--small domain-delete" type="button" disabled={blocked || !state.data.totals.total || state.data.totals.primaryCount > 0 || state.data.totals.cleaningCount > 0} onClick={() => void prepare('all_and_remove')}>{t('清理全部关联邮箱并移除配置')}</button>
        </div>
      </div>}
    </>}
    {state.job && <div className="domain-cleanup-progress" role="status" aria-live="polite">
      <strong>{t(statusLabels[state.job.status])}</strong>
      <p>{t('已清理 {completed} / {total} 个邮箱，待清理对象 {objects} 个', {
        completed: state.job.completed, total: state.job.total, objects: state.job.objectsPending,
      })}</p>
      {state.job.error && <p>{t(state.job.error)}</p>}
      {['failed', 'pending'].includes(state.job.status) && <button className="button button--secondary button--small" type="button" disabled={busy} onClick={() => void state.retry()}>{t('重试清理任务')}</button>}
    </div>}
    {preview && <DangerConfirmDialog icon={Trash2} eyebrow={t('永久清理')} title={t('确认清理 {domain}？', { domain })}
      description={t('涉及 {users} 位用户、{mailboxes} 个邮箱、{messages} 封邮件、{drafts} 份草稿和 {attachments} 个附件。', {
        users: preview.summary.userCount, mailboxes: preview.summary.mailboxCount, messages: preview.summary.messageCount,
        drafts: preview.summary.draftCount, attachments: preview.summary.attachmentCount,
      }) + ' ' + t('预计释放 {bytes} 字节；保留 {count} 封无人收件历史邮件。', { bytes: preview.summary.bytes, count: preview.summary.unassignedMessageCount })}
      impactTitle={t('主存储数据无法恢复')}
      impactDescription={t(mode === 'all_and_remove'
        ? '全部目标清理完成后移除域名配置。无人收件历史邮件保留；备份按原保留策略保存。'
        : '仅清理选中邮箱；其他邮箱和无人收件历史数据保留。备份按原保留策略保存。')}
      confirmation={{ label: t('输入域名 {domain} 确认', { domain }), expected: domain, value: confirmation, onChange: setConfirmation, inputMode: 'text' }}
      confirmLabel={t('提交清理任务')} busy={busy} error={state.error} onCancel={() => setPreview(null)} onConfirm={() => void submit()} />}
  </section>
}
