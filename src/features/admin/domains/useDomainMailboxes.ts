import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type DomainCleanupJob, type DomainMailboxPage } from '../../../shared/api'
import { t } from '../../../shared/i18n'

export function useDomainMailboxes(domain: string, onChanged: () => Promise<void>) {
  const [data, setData] = useState<DomainMailboxPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [jobId, setJobId] = useState('')
  const [job, setJob] = useState<DomainCleanupJob | null>(null)
  const changedRef = useRef(onChanged)
  const requestRef = useRef<AbortController | null>(null)
  changedRef.current = onChanged

  const reload = useCallback(async (cursor?: string) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setError('')
    try {
      const next = await api.domainMailboxes(domain, cursor, controller.signal)
      if (controller.signal.aborted) return
      setData(next)
      if (next.activeJob) setJobId(next.activeJob.id)
    } catch (error) {
      if (!controller.signal.aborted) setError(t(error instanceof Error ? error.message : '加载关联邮箱失败。'))
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }, [domain])

  useEffect(() => {
    void reload()
    return () => requestRef.current?.abort()
  }, [reload])

  useEffect(() => {
    if (!jobId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const result = await api.domainCleanupJob(jobId, controller.signal)
        if (controller.signal.aborted) return
        setJob(result.job)
        if (result.job.status === 'completed') {
          await reload()
          await changedRef.current()
          return
        }
        if (result.job.status === 'failed') return
      } catch (error) {
        if (controller.signal.aborted) return
        setError(t(error instanceof Error ? error.message : '加载清理进度失败。'))
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [jobId, reload])

  async function retry() {
    try {
      setError('')
      await api.retryDomainCleanup(jobId)
      setJob(null)
      // 更换轮询依赖，让同一任务恢复后立即查询最新进度。
      setJobId('')
      await reload()
    } catch (error) { setError(t(error instanceof Error ? error.message : '重试清理失败。')) }
  }

  return { data, loading, error, setError, job, setJobId, reload, retry }
}
