const pauses = new Map<string, { until: number; message: string }>()

export function requestPause(origin: string): string | undefined {
  const pause = pauses.get(origin)
  if (!pause) return undefined
  if (pause.until <= Date.now()) { pauses.delete(origin); return undefined }
  return pause.message
}

export function recordRequestPause(origin: string, data: unknown, status: number): void {
  if (status !== 503 || !data || typeof data !== 'object') return
  const value = data as Record<string, unknown>
  if (value.code !== 'd1_daily_limit') return
  const delay = typeof value.retryAfterSeconds === 'number' && Number.isFinite(value.retryAfterSeconds)
    ? Math.min(300, Math.max(1, value.retryAfterSeconds)) : 30
  pauses.set(origin, { until: Date.now() + delay * 1000,
    message: typeof value.error === 'string' ? value.error.slice(0, 500) : 'D1 daily quota exhausted; retry later.' })
  while (pauses.size > 8) pauses.delete(pauses.keys().next().value!)
}
