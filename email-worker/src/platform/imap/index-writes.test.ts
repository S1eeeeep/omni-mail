import { afterEach, describe, expect, it, vi } from 'vitest'
import { needsIndexTrim, rememberIndexTrim } from './index-writes'

afterEach(() => vi.useRealTimers())
describe('索引裁剪条件', () => {
  it('首次、新增、限额调整和定期核查才裁剪，失败未记录时可重试', () => {
    vi.useFakeTimers()
    const db = {} as D1Database
    expect(needsIndexTrim(db, 'gmail:one', 500, false)).toBe(true)
    expect(needsIndexTrim(db, 'gmail:one', 500, false)).toBe(true)
    rememberIndexTrim(db, 'gmail:one', 500)
    expect(needsIndexTrim(db, 'gmail:one', 500, false)).toBe(false)
    expect(needsIndexTrim(db, 'gmail:one', 500, true)).toBe(true)
    expect(needsIndexTrim(db, 'gmail:one', 200, false)).toBe(true)
    expect(needsIndexTrim(db, 'gmail:two', 500, false)).toBe(true)
    vi.advanceTimersByTime(6 * 60 * 60 * 1000)
    expect(needsIndexTrim(db, 'gmail:one', 500, false)).toBe(true)
  })
})
