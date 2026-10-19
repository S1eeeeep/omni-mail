import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseEnv } from 'node:util'
import { root, runWrangler, withRetry } from './wrangler-command.mjs'

const ACCOUNT_ID = /^[a-f0-9]{32}$/i
const DATABASE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,254}$/
export const DEFAULT_DATABASE_NAME = 'omni-mail-db'
const LEGACY_DATABASE_NAME = 'omnimail-db'

async function databaseByName(get, accountId, name) {
  // 数据库详情接口接收 UUID；名称查找使用列表过滤，并核对全名，避免误认近似名称。
  for (let page = 1; page <= 100; page++) {
    const query = new URLSearchParams({ name, per_page: '100', page: String(page) })
    const databases = await get(`/accounts/${accountId}/d1/database?${query}`)
    if (!Array.isArray(databases) || databases.length > 100 || databases.some((database) => (
      typeof database?.name !== 'string' || !database.name || database.name.length > 255
      || /[\0\r\n]/.test(database.name) || typeof database.uuid !== 'string' || !DATABASE_ID.test(database.uuid)
    ))) throw new Error('D1 数据库列表响应无效，无法确认部署目标。')
    const matches = databases.filter((database) => database.name === name)
    if (matches.length > 1) throw new Error('D1 数据库名称查询结果不唯一，已停止部署。')
    if (matches.length === 1) return matches[0]
    if (databases.length < 100) return null
  }
  throw new Error('D1 数据库名称查询结果过多，请显式配置 database_id。')
}

export function deploymentEnvironment(values, inherited = process.env) {
  const files = values['env-file'] ?? ['.env', '.env.local', ...(values.env ? [`.env.${values.env}`, `.env.${values.env}.local`] : [])]
  const loaded = {}
  for (const path of files) {
    try { Object.assign(loaded, parseEnv(readFileSync(resolve(root, path), 'utf8'))) }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取部署环境文件。') }
  }
  // 与 Wrangler 一致：后面的文件覆盖前面的，进程环境优先。目标值必须明确，不能猜测插值结果。
  const result = { ...loaded, ...inherited }
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID', 'WRANGLER_CI_OVERRIDE_NAME']) {
    if (result[name]?.includes('$')) throw new Error(`${name} 请使用明确值，不支持插值目标。`)
  }
  return result
}

export async function readDeploymentConfig(values) {
  const { experimental_readRawConfig, unstable_readConfig } = await import('wrangler')
  const args = { config: values.config, env: values.env }
  const raw = experimental_readRawConfig(args)
  if (!raw.configPath || (values.env && !raw.rawConfig.env?.[values.env])) {
    throw new Error('未找到本次部署使用的 Wrangler 配置或环境。')
  }
  return { ...raw, configPath: resolve(root, raw.configPath), config: unstable_readConfig(args, { hideWarnings: true }) }
}

export async function cloudflareReader(values, { run = runWrangler, retry = withRetry, fetcher = fetch } = {}) {
  const args = ['auth', 'token', '--json']
  for (const name of ['config', 'env', 'profile', 'env-file']) {
    for (const value of values[name] === undefined ? [] : [].concat(values[name])) args.push(`--${name}`, value)
  }
  let credential
  try { credential = JSON.parse(await run(args, { capture: true, sensitive: true })) }
  catch { throw new Error('无法读取 Wrangler 登录凭据，请检查登录配置或构建 API Token。') }
  const headerValue = (value) => typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\x00-\x20\x7f]/.test(value)
  const headers = new Headers()
  if (['oauth', 'api_token'].includes(credential?.type) && headerValue(credential.token)) {
    headers.set('Authorization', `Bearer ${credential.token}`)
  } else if (credential?.type === 'api_key' && headerValue(credential.key) && headerValue(credential.email)) {
    headers.set('X-Auth-Key', credential.key); headers.set('X-Auth-Email', credential.email)
  } else throw new Error('Wrangler 返回了无法识别的登录凭据。')
  return (path) => retry(async () => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      headers, method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
    })
    let data
    try { data = await response.json() } catch { throw new Error(`Cloudflare 查询响应无效（HTTP ${response.status}）。`) }
    // 只有明确的 Worker 不存在才能创建；权限拒绝、普通 404、响应格式错误一律停止。
    const missingCode = /\/workers\/scripts\/[^/]+\/settings$/.test(path) ? 10007
      : /\/d1\/database\/[^/?]+$/.test(path) ? 7404 : undefined
    if (response.status === 404 && missingCode && data?.errors?.length === 1 && data.errors[0].code === missingCode) return null
    if (!response.ok || data?.success !== true) {
      const codes = Array.isArray(data?.errors) ? data.errors.map((error) => error.code).filter(Number.isInteger) : []
      throw new Error(`Cloudflare 目标查询失败（HTTP ${response.status}，code: ${codes.join(',')}）。请检查 Worker 读取和 D1 编辑权限。`)
    }
    return data.result
  }, { label: '读取部署目标' })
}

export async function resolveDeploymentTarget(values, { read = readDeploymentConfig, get, environment = deploymentEnvironment(values) } = {}) {
  const loaded = await read(values)
  const workerName = environment.WRANGLER_CI_OVERRIDE_NAME ?? loaded.config.name
  if (typeof workerName !== 'string' || !WORKER_NAME.test(workerName)) throw new Error('Worker 部署名称无效。')
  const bindings = loaded.config.d1_databases
  const matches = bindings?.filter((binding) => binding.binding === 'DB')
  if (matches?.length !== 1) throw new Error('配置必须包含唯一的 D1 绑定 DB。')
  let accountId = environment.CLOUDFLARE_ACCOUNT_ID || environment.CF_ACCOUNT_ID || loaded.config.account_id
  if (!accountId) {
    const accounts = await get('/accounts?per_page=2')
    if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error('无法唯一确定 Cloudflare 账户，请设置 CLOUDFLARE_ACCOUNT_ID。')
    accountId = accounts[0].id
  }
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) throw new Error('Cloudflare 账户 ID 无效。')
  const path = `/accounts/${accountId}/workers/scripts/${workerName}/settings`
  const settings = await get(path)
  const configured = matches[0]
  let databaseId
  if (settings !== null) {
    if (!Array.isArray(settings?.bindings)) throw new Error('线上 Worker 绑定响应无效，已停止部署。')
    const existing = settings.bindings.filter((binding) => binding.name === 'DB')
    if (existing.length > 1 || (existing.length === 1
      && (existing[0].type !== 'd1' || typeof existing[0].id !== 'string' || !DATABASE_ID.test(existing[0].id)))) {
      throw new Error('已有 Worker 缺少有效的 DB 绑定，请在 Cloudflare 核对绑定，不能自动创建替代数据库。')
    }
    databaseId = existing[0]?.id
    if (databaseId && configured.database_id && configured.database_id !== databaseId) {
      throw new Error('配置中的 database_id 与线上 DB 绑定不一致，已停止以避免迁移或切换错库。')
    }
  }
  if (!databaseId && (configured.database_id || configured.database_name)) {
    const identifier = configured.database_id || configured.database_name
    if (typeof identifier !== 'string' || !identifier || identifier.length > 255 || /[\0\r\n]/.test(identifier)
      || (configured.database_id && !DATABASE_ID.test(identifier))) throw new Error('D1 数据库配置无效。')
    const database = configured.database_id
      ? await get(`/accounts/${accountId}/d1/database/${encodeURIComponent(identifier)}`)
      : await databaseByName(get, accountId, identifier)
    databaseId = database?.uuid
    if (typeof databaseId !== 'string' || !DATABASE_ID.test(databaseId)) throw new Error('指定的 D1 数据库不存在或返回的 ID 无效。')
    if (configured.database_id && configured.database_id !== databaseId) throw new Error('查询返回的 D1 ID 与配置不一致，已停止部署。')
  } else if (!databaseId) {
    // Workers Builds 可以预创建无 DB 的 Worker。其他服务的数据库与本次建库无关；
    // 只对默认库名和历史库名的冲突停止，已有 DB 绑定始终优先，不能猜测换库。
    for (const name of [DEFAULT_DATABASE_NAME, LEGACY_DATABASE_NAME]) {
      if (await databaseByName(get, accountId, name)) {
        const state = settings === null ? '首次部署目标尚未创建' : '已有 Worker 缺少有效的 DB 绑定'
        throw new Error(`${state}，但账户中已存在 ${name}。请恢复 DB 绑定，或显式填写确认过的 database_id，不能自动复用同名数据库。`)
      }
    }
  }
  return { ...loaded, values, workerName, accountId, bindings, databaseId, workerExists: settings !== null }
}

export function writeDeploymentTarget(target) {
  const config = structuredClone(target.rawConfig)
  const selected = target.values.env ? config.env[target.values.env] : config
  selected.name = target.workerName
  config.account_id = target.accountId
  if (target.values.env) selected.account_id = target.accountId
  selected.d1_databases = target.bindings.map((binding) => {
    if (binding.binding !== 'DB') return binding
    if (!target.databaseId) return { ...binding, database_name: DEFAULT_DATABASE_NAME }
    const result = { ...binding, database_id: target.databaseId }
    delete result.database_name
    return result
  })
  // 放在原配置同目录，保持 main、assets、迁移目录等所有相对路径的语义；不改用户配置。
  const path = join(dirname(target.configPath), `.wrangler-deploy-${randomUUID()}.json`)
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { path, dispose() { unlinkSync(path) } }
}

export function targetArguments(values, configPath, deploy = false) {
  const args = ['--config', configPath]
  for (const name of ['env', 'env-file', 'profile', ...(deploy ? ['outdir', 'minify'] : [])]) {
    for (const value of values[name] === undefined ? [] : [].concat(values[name])) {
      if (value === true) args.push(`--${name}`)
      else if (value !== false) args.push(`--${name}`, value)
    }
  }
  return args
}
