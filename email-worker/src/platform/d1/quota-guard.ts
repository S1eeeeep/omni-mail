import type { Env } from '../../app/types'

interface QuotaState { attempts: number; blockedUntil: number; resetAt: number; generation: number }
const states = new WeakMap<object, QuotaState>()
const databases = new WeakMap<object, D1Database>()
const statements = new WeakMap<object, D1PreparedStatement>()

export class D1QuotaError extends Error {
  constructor(readonly resetAt: number, readonly retryAt: number) {
    super('D1 每日读写额度已用完。')
    this.name = 'D1QuotaError'
  }
}

export function isD1QuotaError(error: unknown): boolean {
  return error instanceof D1QuotaError || (error instanceof Error
    && /D1[\s\S]*exceeded[\s\S]*free tier daily row (read|write) limit/i.test(error.message))
}

function stateError(state: QuotaState): D1QuotaError { return new D1QuotaError(state.resetAt, state.blockedUntil) }

async function execute<T>(state: QuotaState, operation: () => Promise<T>): Promise<T> {
  const now = Date.now()
  if (state.blockedUntil > now) throw stateError(state)
  const generation = state.generation
  try {
    const result = await operation()
    // 并发中的旧成功响应不能清除另一请求刚确认的额度故障。
    if (state.generation === generation) { state.attempts = 0; state.blockedUntil = 0; state.resetAt = 0 }
    return result
  } catch (error) {
    if (!isD1QuotaError(error)) throw error
    const first = state.attempts === 0
    state.generation++
    state.attempts = Math.min(5, state.attempts + 1)
    state.resetAt = Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000
    state.blockedUntil = Math.min(state.resetAt, now + Math.min(300_000, 30_000 * 2 ** (state.attempts - 1)))
    if (first) console.warn({ event: 'd1_daily_limit', resetAt: state.resetAt })
    throw stateError(state)
  }
}

function statementProxy(statement: D1PreparedStatement, state: QuotaState): D1PreparedStatement {
  const proxy = new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => statementProxy(target.bind(...values), state)
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (['first', 'all', 'run', 'raw'].includes(String(property))) {
        return (...args: unknown[]) => execute(state, () => value.apply(target, args))
      }
      return value.bind(target)
    },
  })
  statements.set(proxy, statement)
  return proxy
}

export function guardedD1(db: D1Database): D1Database {
  if (states.has(db)) return db
  const cached = databases.get(db)
  if (cached) return cached
  const state: QuotaState = { attempts: 0, blockedUntil: 0, resetAt: 0, generation: 0 }
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => statementProxy(target.prepare(sql), state)
      if (property === 'batch') return (batch: D1PreparedStatement[]) => execute(state, () => target.batch(
        batch.map((statement) => statements.get(statement) || statement),
      ))
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property === 'exec' || property === 'dump') return (...args: unknown[]) => execute(state, () => value.apply(target, args))
      return value.bind(target)
    },
  })
  databases.set(db, proxy)
  states.set(proxy, state)
  return proxy
}

export function quotaEnvironment(env: Env): Env { return { ...env, DB: guardedD1(env.DB) } }

export function d1QuotaResponse(db: D1Database): Response | undefined {
  const state = states.get(db)
  if (!state?.resetAt || state.resetAt <= Date.now()) return undefined
  const retryAfterSeconds = Math.max(1, Math.ceil((state.blockedUntil - Date.now()) / 1000))
  return Response.json({
    code: 'd1_daily_limit', error: 'D1 每日读写额度已用完，请等待额度恢复或由管理员升级套餐。',
    resetAt: state.resetAt, retryAfterSeconds,
  }, { status: 503, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': String(retryAfterSeconds) } })
}

export function quotaQueueDelay(error: D1QuotaError): number {
  return Math.max(1, Math.min(86_400, Math.ceil((error.resetAt - Date.now()) / 1000) + 30))
}
