import type { Env } from '../../app/types'

const STATE_KEY = 'message_search_backfill_v2'
const SCAN_LIMIT = 200
const QUEUE_LIMIT = 20
const RECHECK_SECONDS = 24 * 60 * 60

function checkpoint(raw: string | undefined): { afterId: string; nextScanAt: number } {
  try {
    const value = JSON.parse(raw || '')
    if (typeof value.afterId === 'string' && value.afterId.length <= 100
      && Number.isSafeInteger(value.nextScanAt) && value.nextScanAt >= 0) return value
  } catch { /* 旧实例没有进度时，从头进行一次有界核查。 */ }
  return { afterId: '', nextScanAt: 0 }
}

export async function enqueueSearchBackfill(env: Env, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(STATE_KEY).first<{ value: string }>()
  const state = checkpoint(row?.value)
  if (state.nextScanAt > now) return
  // 先按主键限制扫描窗口，再查缺失项；即使所有正文都已索引，也不会每轮扫描整表。
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.body_key, s.message_id AS indexed_id
     FROM (SELECT id, body_key FROM messages WHERE id > ? ORDER BY id LIMIT ?) m
     LEFT JOIN message_search s ON s.message_id = m.id ORDER BY m.id`,
  ).bind(state.afterId, SCAN_LIMIT).all<{ id: string; body_key: string | null; indexed_id: string | null }>()
  let queued = 0
  let processed = 0
  for (const message of results) {
    if (message.body_key && !message.indexed_id) {
      // 发送失败时不保存新游标；重复发送可由幂等索引写入安全处理，不能漏过失败记录。
      await env.MAIL_QUEUE.send({ kind: 'index', messageId: message.id })
      queued++
    }
    state.afterId = message.id
    processed++
    if (queued >= QUEUE_LIMIT) break
  }
  if (processed === results.length && results.length < SCAN_LIMIT) {
    state.afterId = ''
    state.nextScanAt = now + RECHECK_SECONDS
  }
  await env.DB.prepare(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
     WHERE settings.value = ?`,
  ).bind(STATE_KEY, JSON.stringify(state), now, row?.value ?? '').run()
}
