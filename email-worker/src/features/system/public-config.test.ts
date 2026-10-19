import { describe, expect, it } from 'vitest'
import { publicConfig } from './public-config'
import type { Env } from '../../app/types'

function environment(settings: Record<string, string>, credentials = false): Env {
  return {
    DB: {
      prepare: () => ({
        all: async () => ({
          results: Object.entries(settings).map(([key, value]) => ({ key, value })),
        }),
      }),
    },
    MAIL_BUCKET: { get: async () => null },
    MAIL_QUEUE: { send: async () => undefined },
    LINUX_DO_CLIENT_ID: credentials ? 'client' : undefined,
    LINUX_DO_CLIENT_SECRET: credentials ? 'secret' : undefined,
    SUPER_ADMIN_EMAIL: 'owner@example.com',
  } as unknown as Env
}

describe('public registration configuration', () => {
  it('单个全局密钥支持全部邮箱，同时保留显式关闭开关且不泄露主密钥', async () => {
    const env = environment({})
    env.MAIL_CREDENTIALS_KEY = 'global-do-not-return-this-secret-value'
    env.GMAIL_IMAP_ENABLED = 'false'
    const config = await publicConfig(env)
    expect(config).toMatchObject({ iCloudEnabled: true, gmailEnabled: false,
      microsoftEnabled: true, qqMailEnabled: true, naverMailEnabled: true, yandexMailEnabled: true })
    expect(JSON.stringify(config)).not.toContain('do-not-return')
  })
  it('makes Linux DO registration available without Turnstile when Connect is configured', async () => {
    const config = await publicConfig(environment({
      external_registration_enabled: '1',
      external_registration_method: 'linuxdo',
    }, true))
    expect(config).toMatchObject({
      registrationEnabled: true,
      registrationAvailable: true,
      registrationMethod: 'linuxdo',
      linuxDoLoginEnabled: true,
      registrationProtectionReady: false,
    })
  })

  it('does not expose an unusable registration entry point', async () => {
    const config = await publicConfig(environment({
      external_registration_enabled: '1',
      external_registration_method: 'linuxdo',
    }))
    expect(config.registrationEnabled).toBe(true)
    expect(config.registrationAvailable).toBe(false)
    expect(config.linuxDoLoginEnabled).toBe(false)
  })

  it('enables sending when only SendFlare is configured', async () => {
    const env = environment({})
    env.SENDFLARE_API_KEY = 'sf_do-not-return'
    const config = await publicConfig(env)
    expect(config.replyEnabled).toBe(true)
    expect(JSON.stringify(config)).not.toContain('sf_do-not-return')
  })

  it('exposes only external mailbox readiness, never credential keys', async () => {
    const env = environment({})
    env.ICLOUD_CREDENTIALS_KEY = 'icloud-do-not-return-this-secret-value'
    env.GMAIL_CREDENTIALS_KEY = 'gmail-do-not-return-this-secret-value'
    env.MICROSOFT_CREDENTIALS_KEY = 'microsoft-do-not-return-this-secret-value'
    env.QQ_MAIL_CREDENTIALS_KEY = 'qq-mail-do-not-return-this-secret-value'
    env.NAVER_MAIL_CREDENTIALS_KEY = 'naver-mail-do-not-return-this-secret-value'
    env.YANDEX_MAIL_CREDENTIALS_KEY = 'yandex-mail-do-not-return-this-secret-value'
    const config = await publicConfig(env)

    expect(config.iCloudEnabled).toBe(true)
    expect(config.gmailEnabled).toBe(true)
    expect(config.microsoftEnabled).toBe(true)
    expect(config.qqMailEnabled).toBe(true)
    expect(config.naverMailEnabled).toBe(true)
    expect(config.yandexMailEnabled).toBe(true)
    expect(JSON.stringify(config)).not.toContain('do-not-return')
  })

  it('exposes the configured administrator email only before setup', async () => {
    const pending = await publicConfig(environment({}))
    const complete = await publicConfig(environment({ setup_complete: '1' }))

    expect(pending.superAdminEmail).toBe('owner@example.com')
    expect(complete.superAdminEmail).toBe('')
  })

  it('exposes the official extension switch with a safe disabled default', async () => {
    const disabled = await publicConfig(environment({}))
    const enabled = await publicConfig(environment({ official_extension_enabled: '1' }))

    expect(disabled.officialExtensionEnabled).toBe(false)
    expect(enabled.officialExtensionEnabled).toBe(true)
  })

  it('keeps mailbox workspace entries visible by default and allows hiding them', async () => {
    const defaults = await publicConfig(environment({}))
    const disabled = await publicConfig(environment({
      icloud_workspace_enabled: '0',
      linuxdo_mail_workspace_enabled: '0',
      gmail_workspace_enabled: '0',
      microsoft_workspace_enabled: '0',
      qq_mail_workspace_enabled: '0',
      naver_mail_workspace_enabled: '0',
      yandex_mail_workspace_enabled: '0',
    }))

    expect(defaults.iCloudWorkspaceEnabled).toBe(true)
    expect(defaults.linuxDoMailWorkspaceEnabled).toBe(true)
    expect(defaults.gmailWorkspaceEnabled).toBe(true)
    expect(defaults.microsoftWorkspaceEnabled).toBe(true)
    expect(defaults.qqMailWorkspaceEnabled).toBe(true)
    expect(defaults.naverMailWorkspaceEnabled).toBe(true)
    expect(defaults.yandexMailWorkspaceEnabled).toBe(true)
    expect(disabled.iCloudWorkspaceEnabled).toBe(false)
    expect(disabled.linuxDoMailWorkspaceEnabled).toBe(false)
    expect(disabled.gmailWorkspaceEnabled).toBe(false)
    expect(disabled.microsoftWorkspaceEnabled).toBe(false)
    expect(disabled.qqMailWorkspaceEnabled).toBe(false)
    expect(disabled.naverMailWorkspaceEnabled).toBe(false)
    expect(disabled.yandexMailWorkspaceEnabled).toBe(false)
  })

  it('旧环境开关不再生效，设置仅控制 NAVER 和 Yandex 入口显示', async () => {
    const env = {
      ...environment({ naver_mail_workspace_enabled: '0', yandex_mail_workspace_enabled: '0' }),
      MAIL_CREDENTIALS_KEY: 'global-do-not-return-this-secret-value',
      NAVER_MAIL_IMAP_ENABLED: 'false',
      YANDEX_MAIL_IMAP_ENABLED: 'false',
    }
    expect(await publicConfig(env)).toMatchObject({
      naverMailEnabled: true, yandexMailEnabled: true,
      naverMailWorkspaceEnabled: false, yandexMailWorkspaceEnabled: false,
    })
    expect(await publicConfig({ ...env, MAIL_CREDENTIALS_KEY: '' })).toMatchObject({
      naverMailEnabled: false, yandexMailEnabled: false,
    })
  })

  it('exposes an empty random mailbox prefix by default', async () => {
    const defaultConfig = await publicConfig(environment({}))
    const configured = await publicConfig(environment({ random_mailbox_prefix: 'alias-' }))
    const invalid = await publicConfig(environment({ random_mailbox_prefix: '-invalid' }))

    expect(defaultConfig.randomMailboxPrefix).toBe('')
    expect(configured.randomMailboxPrefix).toBe('alias-')
    expect(invalid.randomMailboxPrefix).toBe('')
  })
})
