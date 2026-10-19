// 参数来自各提供商的固定字段目录，仍校验标识符，避免未来调用方误传外部输入。
export function changedIndexFields(table: string, fields: readonly string[]): string {
  if (![table, ...fields].every((name) => /^[a-z][a-z0-9_]*$/.test(name)) || !fields.length) {
    throw new Error('Invalid mail index fields')
  }
  return fields.map((field) => `${table}.${field} IS NOT excluded.${field}`).join(' OR ')
}

export function canonicalMailFlags(values: readonly string[]): string {
  return JSON.stringify([...new Set(values)].sort())
}

const trimmed = new WeakMap<D1Database, Map<string, { limit: number; expiresAt: number }>>()

export function needsIndexTrim(db: D1Database, scope: string, limit: number, added: boolean): boolean {
  const previous = trimmed.get(db)?.get(scope)
  return added || !previous || previous.limit !== limit || previous.expiresAt <= Date.now()
}

export function rememberIndexTrim(db: D1Database, scope: string, limit: number): void {
  let entries = trimmed.get(db)
  if (!entries) { entries = new Map(); trimmed.set(db, entries) }
  entries.delete(scope)
  entries.set(scope, { limit, expiresAt: Date.now() + 6 * 60 * 60 * 1000 })
  // 冷启动或上限变更重新核查；稳定同步不重复裁剪，也不为记忆清理状态写 D1。
  while (entries.size > 512) entries.delete(entries.keys().next().value!)
}
