interface Entry { stamp: string; expiresAt: number; body: unknown }
const caches = new WeakMap<D1Database, Map<string, Entry>>()

export function notificationVersionStatement(db: D1Database, userId: string, sources: readonly string[]) {
  return db.prepare(
    `SELECT 'omnimail' AS source,version FROM mail_state_versions WHERE user_id=? AND ?=1
     UNION ALL SELECT source,version FROM mail_notification_versions WHERE user_id=? AND source IN (${sources.map(() => '?').join(',')})
     ORDER BY source`,
  ).bind(userId, Number(sources.includes('omnimail')), userId, ...sources)
}

export function notificationStamp(rows: Array<{ source: string; version: number }>): string {
  return JSON.stringify(rows)
}

export function cachedNotification(db: D1Database, key: string, stamp: string): unknown {
  const cache = caches.get(db)
  const entry = cache?.get(key)
  if (!entry) return undefined
  if (entry.stamp !== stamp || entry.expiresAt <= Date.now()) { cache!.delete(key); return undefined }
  cache!.delete(key); cache!.set(key, entry)
  return entry.body
}

export function cacheNotification(db: D1Database, key: string, stamp: string, body: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 256 * 1024) return
  let cache = caches.get(db)
  if (!cache) { cache = new Map(); caches.set(db, cache) }
  cache.delete(key)
  cache.set(key, { stamp, expiresAt: Date.now() + 300_000, body })
  while (cache.size > 128) cache.delete(cache.keys().next().value!)
}
