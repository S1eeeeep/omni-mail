import type { PageInfo } from './admin'

export interface DomainMailbox {
  address: string; userId: string; userEmail: string; displayName: string
  isPrimary: boolean; isActive: boolean; domainActive: boolean; isCleaning: boolean
}

export interface DomainMailboxPage {
  mailboxes: DomainMailbox[]; page: PageInfo
  totals: { total: number; primaryCount: number; cleaningCount: number }
  activeJob: { id: string; status: DomainCleanupJob['status'] } | null
}

export interface DomainCleanupSummary {
  mailboxCount: number; userCount: number; messageCount: number; draftCount: number
  attachmentCount: number; bytes: number; unassignedMessageCount: number
}

export interface DomainCleanupPreview { jobId: string; expiresAt: number; summary: DomainCleanupSummary }

export interface DomainCleanupJob {
  id: string; domain: string; mode: 'selected' | 'all_and_remove'
  status: 'pending' | 'running' | 'waiting_for_objects' | 'failed' | 'completed'
  error: string; summary: DomainCleanupSummary; total: number; completed: number; objectsPending: number
}
