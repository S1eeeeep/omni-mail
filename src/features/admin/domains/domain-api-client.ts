import type { DomainCleanupJob, DomainCleanupPreview, DomainMailboxPage } from '../../../shared/api/api-types'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>

export function createDomainManagementApi(request: Request, jsonBody: (value: unknown) => string) {
  const domainPath = (name: string) => `/api/admin/domains/${encodeURIComponent(name)}`
  return {
    domainMailboxes: (name: string, cursor?: string, signal?: AbortSignal) => {
      const query = new URLSearchParams({ limit: '50' })
      if (cursor) query.set('cursor', cursor)
      return request<DomainMailboxPage>(`${domainPath(name)}/mailboxes?${query}`, { signal })
    },
    previewDomainCleanup: (name: string, mode: DomainCleanupJob['mode'], addresses: string[]) => (
      request<DomainCleanupPreview>(`${domainPath(name)}/cleanup/preview`, { method: 'POST', body: jsonBody({ mode, addresses }) })
    ),
    submitDomainCleanup: (name: string, jobId: string, confirmDomain: string) => (
      request<{ jobId: string; status: DomainCleanupJob['status'] }>(`${domainPath(name)}/cleanup`, {
        method: 'POST', body: jsonBody({ jobId, confirmDomain }),
      })
    ),
    domainCleanupJob: (id: string, signal?: AbortSignal) => (
      request<{ job: DomainCleanupJob }>(`/api/admin/domain-cleanup-jobs/${encodeURIComponent(id)}`, { signal })
    ),
    retryDomainCleanup: (id: string) => request<{ jobId: string; status: DomainCleanupJob['status'] }>(
      `/api/admin/domain-cleanup-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' },
    ),
  }
}
