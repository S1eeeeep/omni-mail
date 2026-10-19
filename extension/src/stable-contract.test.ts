import { describe, expect, it } from 'vitest'
import { workspaceRoute, type WorkspaceFeatures } from '../../src/app/navigation/workspaceNavigation'
import {
  getIndexedSourceAdapter,
  INDEXED_SOURCE_IDS,
  MAIL_SOURCE_ACCOUNT_STATUSES,
  MAIL_SOURCE_CAPABILITY_IDS,
  MAIL_SOURCE_IDS,
  MAIL_SOURCE_WEB_PATHS,
  normalizeIndexedAccounts,
} from './mail-source'
import { NOTIFICATION_SOURCE_IDS } from './notification-settings'
import { notificationRoute } from './notification-poll'

const enabledFeatures: WorkspaceFeatures = {
  iCloudWorkspaceEnabled: true,
  linuxDoMailWorkspaceEnabled: true,
  gmailWorkspaceEnabled: true,
  microsoftWorkspaceEnabled: true,
  qqMailWorkspaceEnabled: true,
  naverMailWorkspaceEnabled: true,
  yandexMailWorkspaceEnabled: true,
}

describe('Float 1.0 stable source contract', () => {
  it('freezes official source IDs, account states, and capability names', () => {
    expect(MAIL_SOURCE_IDS).toEqual([
      'omnimail', 'icloud', 'linuxdo', 'gmail', 'microsoft', 'qq', 'naver', 'yandex',
    ])
    expect(MAIL_SOURCE_ACCOUNT_STATUSES).toEqual(['active', 'syncing', 'error'])
    expect(MAIL_SOURCE_CAPABILITY_IDS).toEqual([
      'attachments', 'folders', 'reply', 'send', 'sync',
    ])
  })

  it('keeps every official source reachable through its stable Web path', () => {
    for (const source of MAIL_SOURCE_IDS) {
      const route = workspaceRoute(MAIL_SOURCE_WEB_PATHS[source], 'user', enabledFeatures)
      expect(route.path).toBe(MAIL_SOURCE_WEB_PATHS[source])
      expect(route.kind).toBe(source === 'omnimail' ? 'folder' : 'admin')
    }
  })

  it('keeps notifications and deep links aligned with every official source', () => {
    expect(NOTIFICATION_SOURCE_IDS).toEqual(MAIL_SOURCE_IDS)
    for (const source of MAIL_SOURCE_IDS) {
      expect(notificationRoute({
        key: `${source}:account-1:message-1`, source,
        accountId: 'account-1', messageId: 'message-1',
        sender: 'Sender', subject: 'Subject', unread: true,
      })).toBe(
        `${MAIL_SOURCE_WEB_PATHS[source]}?source=${source}&accountId=account-1&messageId=message-1`,
      )
    }
  })

  it('keeps indexed sources on fixed account and Web routes', () => {
    const accountPaths = {
      gmail: '/api/gmail/accounts',
      microsoft: '/api/microsoft/accounts',
      qq: '/api/qq-mail/accounts',
      naver: '/api/naver-mail/accounts',
      yandex: '/api/yandex-mail/accounts',
      linuxdo: '/api/linux-do-mail/account',
    }
    for (const source of INDEXED_SOURCE_IDS) {
      const adapter = getIndexedSourceAdapter(source)
      expect(adapter?.accountsPath).toBe(accountPaths[source])
      expect(adapter?.webPath).toBe(MAIL_SOURCE_WEB_PATHS[source])
    }
  })

  it('normalizes provider-specific failures into the stable error state', () => {
    expect(normalizeIndexedAccounts('gmail', [
      { id: '1', name: 'Active', email: 'active@example.com', status: 'active' },
      { id: '2', name: 'Syncing', email: 'syncing@example.com', status: 'syncing' },
      { id: '3', name: 'Broken', email: 'broken@example.com', status: 'credential_error' },
    ]).map(({ status, needsAttention }) => ({ status, needsAttention }))).toEqual([
      { status: 'active', needsAttention: false },
      { status: 'syncing', needsAttention: false },
      { status: 'error', needsAttention: true },
    ])
  })
})
