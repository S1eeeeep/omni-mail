export interface MessageCounts {
  unread: number
  starred: number
  sent: number
  trash: number
  drafts: number
}

interface Entry { version: number; expiresAt: number; counts: MessageCounts }
const MAX_ENTRIES = 256
const TTL_MS = 60_000
const caches = new WeakMap<D1Database, Map<string, Entry>>()

export function cachedMessageCounts(db: D1Database, key: string, version: number): MessageCounts | undefined {
  const cache = caches.get(db)
  const entry = cache?.get(key)
  if (!entry) return undefined
  if (entry.version !== version || entry.expiresAt <= Date.now()) {
    cache!.delete(key)
    return undefined
  }
  cache!.delete(key)
  cache!.set(key, entry)
  return { ...entry.counts }
}

export function cacheMessageCounts(db: D1Database, key: string, version: number, counts: MessageCounts): void {
  let cache = caches.get(db)
  if (!cache) { cache = new Map(); caches.set(db, cache) }
  cache.delete(key)
  cache.set(key, { version, expiresAt: Date.now() + TTL_MS, counts: { ...counts } })
  // 内存缓存只减少重复统计，不额外写 D1；按绑定隔离并限制容量。
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!)
}
