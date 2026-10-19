import { Bell, ExternalLink, LoaderCircle, RefreshCw, Send, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { request } from '../../../shared/api'
import { t } from '../../../shared/i18n'
import type { OfficialMailSourceId } from '../../../shared/mail/mailSourceContract'

const sources: Array<{ id: OfficialMailSourceId; label: string }> = [
  { id: 'omnimail', label: 'OmniMail' },
  { id: 'icloud', label: 'iCloud' },
  { id: 'linuxdo', label: 'Linux DO' },
  { id: 'gmail', label: 'Gmail' },
  { id: 'microsoft', label: 'Microsoft' },
  { id: 'qq', label: 'QQ' },
  { id: 'naver', label: 'NAVER' },
  { id: 'yandex', label: 'Yandex' },
]

interface TelegramStatus {
  configured: boolean
  botUsername: string
  connected: boolean
  enabled: boolean
  status: 'active' | 'blocked' | 'disconnected'
  sources: OfficialMailSourceId[]
  detailLevel: 'basic' | 'sender' | 'subject'
  includeBody: boolean
  bodyFormat: 'text' | 'rich'
  quietEnabled: boolean
  quietStart: string
  quietEnd: string
  timezone: string
  lastErrorCode: string
}

function message(error: unknown): string {
  return t(error instanceof Error ? error.message : 'Telegram 操作失败，请稍后重试。')
}

export function TelegramNotificationSettings({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [draft, setDraft] = useState<TelegramStatus | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pairing, setPairing] = useState<{ url: string; expiresAt: number } | null>(null)

  async function reload() {
    const next = await request<TelegramStatus>('/api/notification-channels/telegram')
    setStatus(next)
    setDraft(next)
    if (next.connected) setPairing(null)
  }

  useEffect(() => {
    let active = true
    void request<TelegramStatus>('/api/notification-channels/telegram')
      .then((next) => { if (active) { setStatus(next); setDraft(next) } })
      .catch((cause) => { if (active) setError(message(cause)) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!pairing) return
    const interval = window.setInterval(() => {
      if (Date.now() >= pairing.expiresAt * 1000) { setPairing(null); return }
      void reload().catch(() => undefined)
    }, 4000)
    return () => window.clearInterval(interval)
  }, [pairing])

  async function act(label: string, action: () => Promise<void>, success: string) {
    setBusy(label)
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(t(success))
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy('')
    }
  }

  const save = () => act('save', async () => {
    if (!draft) return
    await request('/api/notification-channels/telegram', {
      method: 'PATCH',
      body: JSON.stringify({
        enabled: draft.enabled, sources: draft.sources, detailLevel: draft.detailLevel,
        includeBody: draft.includeBody,
        bodyFormat: draft.bodyFormat,
        quietEnabled: draft.quietEnabled, quietStart: draft.quietStart,
        quietEnd: draft.quietEnd, timezone: draft.timezone,
      }),
    })
    await reload()
  }, 'Telegram 通知设置已保存。')

  const setupBotButton = <button className="button button--secondary" type="button" disabled={!!busy}
    onClick={() => void act('setup', async () => {
      await request('/api/admin/notification-channels/telegram/webhook', { method: 'POST' })
      await reload()
    }, 'Telegram Webhook 已注册。')}>
    {busy === 'setup' && <LoaderCircle className="spin" size={15} />}
    {t('验证并注册 Telegram Bot')}
  </button>

  return <section className="admin-card account-card telegram-card">
    <header><Bell size={17} /><div>
      <h2>{t('Telegram 新邮件提醒')}</h2>
      <p>{t('关闭网页后也可在 Telegram 收到新邮件提醒')}</p>
    </div></header>
    {!status ? <p className="telegram-note">{t('正在读取 Telegram 设置…')}</p>
      : <div className="telegram-settings">
        {!status.configured && <p className="telegram-note">
          {t('实例尚未完成 Telegram Bot 配置，请联系管理员。')}
        </p>}
        {isSuperAdmin && !status.configured && setupBotButton}
        {status.configured && !status.connected && <>
          <p className="telegram-note">{t('点击连接后，在 Telegram 私聊中向 Bot 发送开始命令。连接码十分钟有效。')}</p>
          <button className="button button--primary" type="button" disabled={!!busy}
            onClick={() => {
              const popup = window.open('about:blank', '_blank')
              if (popup) popup.opener = null
              void act('pair', async () => {
                try {
                  const next = await request<{ url: string; expiresAt: number }>(
                    '/api/notification-channels/telegram/pairing', { method: 'POST' })
                  setPairing(next)
                  popup?.location.assign(next.url)
                } catch (cause) {
                  popup?.close()
                  throw cause
                }
              }, '连接链接已生成，请在 Telegram 中点击开始。')
            }}>
            <ExternalLink size={15} />{t('连接 Telegram')}
          </button>
          {pairing && <a href={pairing.url} target="_blank" rel="noopener noreferrer">
            {t('重新打开连接链接')}
          </a>}
          <button className="button button--secondary" type="button" disabled={!!busy}
            onClick={() => void act('refresh', reload, '连接状态已刷新。')}>
            <RefreshCw size={15} />{t('刷新连接状态')}
          </button>
        </>}
        {status.connected && draft && <>
          <div className={`telegram-connection${status.status === 'blocked' ? ' is-blocked' : ''}`}>
            <span className="telegram-connection-dot" aria-hidden="true" />
            <span>{status.status === 'blocked'
            ? t(status.lastErrorCode === 'bot_changed'
              ? '管理员已更换 Bot，请解除连接后与新 Bot 重新配对。'
              : 'Bot 无法向当前私聊发送消息，请在 Telegram 取消屏蔽后重新连接。')
            : t('已连接 Telegram 私聊')}</span>
          </div>
          {status.status === 'active' && status.lastErrorCode && <p className="telegram-note" role="status">
            {t('最近一次推送失败：{code}', { code: status.lastErrorCode })}
          </p>}
          <div className="telegram-section">
            <label className="telegram-toggle"><input type="checkbox" checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
              {t('启用 Telegram 新邮件提醒')}</label>
            <fieldset><legend>{t('通知来源')}</legend><div className="telegram-source-grid">
              {sources.map((source) => <label key={source.id}><input type="checkbox"
                checked={draft.sources.includes(source.id)}
                onChange={(event) => setDraft({ ...draft, sources: event.target.checked
                  ? [...draft.sources, source.id]
                  : draft.sources.filter((item) => item !== source.id) })} />{source.label}</label>)}
            </div></fieldset>
          </div>
          <div className="telegram-section">
            <label className="telegram-field"><span>{t('消息内容')}</span><select
              value={draft.detailLevel}
              onChange={(event) => setDraft({ ...draft, detailLevel: event.target.value as TelegramStatus['detailLevel'] })}>
              <option value="basic">{t('仅来源与站内链接')}</option>
              <option value="sender">{t('包含发件人')}</option>
              <option value="subject">{t('包含发件人与主题')}</option>
            </select></label>
            <div className="telegram-body-option">
              <label className="telegram-toggle"><input type="checkbox" checked={draft.includeBody}
                onChange={(event) => setDraft({ ...draft, includeBody: event.target.checked })} />
                {t('发送 OmniMail 主邮箱正文')}</label>
              {draft.includeBody && <label className="telegram-field"><span>{t('正文格式')}</span><select
                value={draft.bodyFormat}
                onChange={(event) => setDraft({ ...draft, bodyFormat: event.target.value as TelegramStatus['bodyFormat'] })}>
                <option value="text">{t('纯文本')}</option>
                <option value="rich">{t('Telegram 富文本')}</option>
              </select></label>}
              <p className="telegram-note">{t('主邮箱正文可能包含验证码，开启后会发送到 Telegram；外部邮箱不发送正文。')}</p>
              {draft.includeBody && draft.bodyFormat === 'rich' && <p className="telegram-note">
                {t('富文本保留常用排版和安全链接；图片及复杂样式请在站内查看。')}
              </p>}
            </div>
          </div>
          <div className="telegram-section telegram-section--quiet">
            <label className="telegram-toggle"><input type="checkbox" checked={draft.quietEnabled}
              onChange={(event) => setDraft({ ...draft, quietEnabled: event.target.checked })} />
              {t('启用免打扰')}</label>
            {draft.quietEnabled && <div className="telegram-quiet-grid">
              <label className="telegram-field"><span>{t('开始时间')}</span><input type="time"
                value={draft.quietStart} onChange={(event) => setDraft({ ...draft, quietStart: event.target.value })} /></label>
              <label className="telegram-field"><span>{t('结束时间')}</span><input type="time"
                value={draft.quietEnd} onChange={(event) => setDraft({ ...draft, quietEnd: event.target.value })} /></label>
              <label className="telegram-field"><span>{t('时区')}</span><input type="text" maxLength={64}
                value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}
                placeholder="Asia/Singapore" /></label>
            </div>}
            {draft.quietEnabled && <p className="telegram-note">{t('免打扰期间的提醒会跳过，不会在结束后补发。')}</p>}
          </div>
          <div className="telegram-actions">
            <button className="button button--primary" type="button" disabled={!!busy} onClick={() => void save()}>
              {busy === 'save' && <LoaderCircle className="spin" size={15} />}{t('保存通知设置')}
            </button>
            <button className="button button--secondary" type="button" disabled={!!busy}
              onClick={() => void act('test', async () => {
                await request('/api/notification-channels/telegram/test', { method: 'POST' })
              }, '测试消息已发送。')}><Send size={15} />{t('发送测试消息')}</button>
            <button className="button button--secondary" type="button" disabled={!!busy}
              onClick={() => void act('disconnect', async () => {
                await request('/api/notification-channels/telegram', { method: 'DELETE' })
                await reload()
              }, '已解除 Telegram 连接。')}><Unplug size={15} />{t('解除连接')}</button>
          </div>
        </>}
      </div>}
    {error && <p className="account-feedback is-error" role="alert">{error}</p>}
    {notice && <p className="account-feedback is-success" role="status">{notice}</p>}
    {isSuperAdmin && status?.configured && <details className="telegram-admin-tools">
      <summary>{t('Bot 管理')}</summary>
      {setupBotButton}
    </details>}
  </section>
}
