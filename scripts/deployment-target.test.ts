import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { cloudflareReader, deploymentEnvironment, readDeploymentConfig, resolveDeploymentTarget, writeDeploymentTarget } from './deployment-target.mjs'

const accountId = 'a'.repeat(32)
const boundId = '11111111-1111-4111-8111-111111111111'
const wrongId = '22222222-2222-4222-8222-222222222222'
const settings = { bindings: [{ name: 'DB', type: 'd1', id: boundId }] }
const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function config(binding: object = { binding: 'DB' }) {
  const rawConfig = { name: 'omni-mail', account_id: accountId, d1_databases: [binding] }
  return { rawConfig, config: rawConfig, configPath: join(tmpdir(), 'wrangler.jsonc') }
}
const environment = {}
const databaseListPath = (name: string, page = 1) => `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=100&page=${page}`

describe('部署数据库目标解析', () => {
  it('两种库名并存时只使用现有 DB ID，完全不按推导库名查询', async () => {
    const get = vi.fn(async () => settings)
    const result = await resolveDeploymentTarget({}, { get, environment, read: async () => config({ binding: 'DB', database_name: 'omni-mail-db' }) })
    expect(result.databaseId).toBe(boundId)
    expect(result.workerName).toBe('omni-mail')
    expect(get).toHaveBeenCalledExactlyOnceWith(`/accounts/${accountId}/workers/scripts/omni-mail/settings`)
  })

  it('构建系统覆盖名称时查实际 Worker，不改用户源配置', async () => {
    const loaded = config()
    const get = vi.fn(async () => settings)
    const target = await resolveDeploymentTarget({}, { get, read: async () => loaded, environment: { WRANGLER_CI_OVERRIDE_NAME: 'omnimail' } })
    expect(get).toHaveBeenCalledWith(`/accounts/${accountId}/workers/scripts/omnimail/settings`)
    expect(target.workerName).toBe('omnimail')
    expect(loaded.rawConfig.name).toBe('omni-mail')
  })

  it('明确配置 ID 与线上绑定冲突时停止，避免静默切库', async () => {
    await expect(resolveDeploymentTarget({}, { environment, get: async () => settings,
      read: async () => config({ binding: 'DB', database_id: wrongId }),
    })).rejects.toThrow('database_id 与线上 DB 绑定不一致')
  })

  it.each([{}, { bindings: [{ name: 'DB', type: 'kv_namespace', id: boundId }] }, { bindings: [{ name: 'DB', type: 'd1', id: 'invalid' }] },
    { bindings: [...settings.bindings, ...settings.bindings] }])(
    '已有 Worker 绑定无效不能当成首次部署：%j', async (remote) => {
      await expect(resolveDeploymentTarget({}, { environment, read: async () => config(), get: async () => remote })).rejects.toThrow()
    },
  )

  it.each([{ bindings: [] }, { bindings: [{ name: 'SETUP_TOKEN', type: 'secret_text' }, { name: 'SUPER_ADMIN_EMAIL', type: 'plain_text' }] }])(
    '新账号中预创建的 Worker 可以自动创建 DB，兼容已配置变量：%j', async ({ bindings }) => {
      const get = vi.fn().mockResolvedValueOnce({ bindings }).mockResolvedValue([])
      const target = await resolveDeploymentTarget({}, { environment, read: async () => config(), get })
      expect(target).toMatchObject({ workerExists: true, databaseId: undefined })
      expect(get).toHaveBeenCalledWith(databaseListPath('omni-mail-db'))
      expect(get).toHaveBeenLastCalledWith(databaseListPath('omnimail-db'))
    },
  )

  it.each(['omni-mail-db', 'omnimail-db'])(
    'Worker 缺少 DB 而账号已有 %s 时不擅自创建或复用', async (name) => {
      const get = vi.fn(async (path: string) => path.endsWith('/settings') ? { bindings: [] }
        : new URL(path, 'https://api.example').searchParams.get('name') === name ? [{ name, uuid: boundId }] : [])
      await expect(resolveDeploymentTarget({}, { environment, read: async () => config(), get }))
        .rejects.toThrow('请恢复 DB 绑定')
    },
  )

  it.each(['omni-mail', 'omnimail'])('其他服务 D1 不阻止 %s 首次建库，也不会被选为迁移目标', async (workerName) => {
    const get = vi.fn(async (path: string) => {
      if (path.endsWith(`/workers/scripts/${workerName}/settings`)) return { bindings: [] }
      const name = new URL(path, 'https://api.example').searchParams.get('name')
      expect(['omni-mail-db', 'omnimail-db']).toContain(name)
      return [{ name: 'ggesim-frontend-nodes', uuid: wrongId }, { name: `${name}-archive`, uuid: wrongId }]
    })
    const target = await resolveDeploymentTarget({}, { read: async () => config(), get, environment: { WRANGLER_CI_OVERRIDE_NAME: workerName } })
    expect(target).toMatchObject({ workerExists: true, workerName, databaseId: undefined })
    expect(get).toHaveBeenCalledTimes(3)
  })

  it.each([null, {}, { result: [] }, [{ name: 'omni-mail-db', uuid: 'invalid' }], [{ uuid: boundId }]])('数据库列表无效时不能确认目标库不存在：%j', async (databases) => {
    const get = vi.fn().mockResolvedValueOnce({ bindings: [] }).mockResolvedValueOnce(databases)
    await expect(resolveDeploymentTarget({}, { environment, read: async () => config(), get }))
      .rejects.toThrow('列表响应无效')
  })

  it('查询 D1 名称权限失败时保留错误，不能当作目标库不存在', async () => {
    const get = vi.fn().mockResolvedValueOnce({ bindings: [] }).mockRejectedValueOnce(new Error('HTTP 403'))
    await expect(resolveDeploymentTarget({}, { environment, read: async () => config(), get })).rejects.toThrow('HTTP 403')
  })

  it('名称过滤结果分页时继续检查，不能遗漏后续页面中的同名库', async () => {
    const get = vi.fn().mockResolvedValueOnce({ bindings: [] })
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ name: `omni-mail-db-copy-${i}`, uuid: wrongId })))
      .mockResolvedValueOnce([{ name: 'omni-mail-db', uuid: boundId }])
    await expect(resolveDeploymentTarget({}, { environment, read: async () => config(), get })).rejects.toThrow('已存在 omni-mail-db')
    expect(get).toHaveBeenLastCalledWith(databaseListPath('omni-mail-db', 2))
  })

  it('名称查询返回重复全名时拒绝选择数据库', async () => {
    const get = vi.fn().mockResolvedValueOnce({ bindings: [] })
      .mockResolvedValueOnce([{ name: 'omni-mail-db', uuid: boundId }, { name: 'omni-mail-db', uuid: wrongId }])
    await expect(resolveDeploymentTarget({}, { environment, read: async () => config(), get })).rejects.toThrow('不唯一')
  })

  it('Worker 尚未绑定 DB 时允许显式指定并校验已有数据库', async () => {
    const get = vi.fn().mockResolvedValueOnce({ bindings: [] }).mockResolvedValueOnce({ uuid: boundId })
    const target = await resolveDeploymentTarget({}, { environment, read: async () => config({ binding: 'DB', database_id: boundId }), get })
    expect(target).toMatchObject({ workerExists: true, databaseId: boundId })
    expect(get).toHaveBeenLastCalledWith(`/accounts/${accountId}/d1/database/${boundId}`)
  })

  it('显式配置数据库 ID 时拒绝查询响应返回其他数据库', async () => {
    const get = vi.fn().mockResolvedValueOnce({ bindings: [] }).mockResolvedValueOnce({ uuid: wrongId })
    await expect(resolveDeploymentTarget({}, { environment, read: async () => config({ binding: 'DB', database_id: boundId }), get }))
      .rejects.toThrow('ID 与配置不一致')
  })

  it('Worker 确认不存在且未指定数据库，才返回首次创建状态', async () => {
    expect(await resolveDeploymentTarget({}, { environment, read: async () => config(), get: async (path: string) => path.endsWith('/settings') ? null : [] }))
      .toMatchObject({ workerExists: false, databaseId: undefined })
  })

  it('首次创建使用固定名称 omni-mail-db，已有同名库时不能自动复用', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omnimail-new-db-test-')); directories.push(directory)
    const loaded = config()
    loaded.configPath = join(directory, 'wrangler.jsonc')
    const get = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([{ name: 'omni-mail-db', uuid: wrongId }])
    await expect(resolveDeploymentTarget({}, { environment, read: async () => loaded, get })).rejects.toThrow('已存在 omni-mail-db')
    const target = await resolveDeploymentTarget({}, { environment, read: async () => loaded, get: async (path: string) => path.endsWith('/settings') ? null : [] })
    const file = writeDeploymentTarget(target)
    try {
      expect(JSON.parse(readFileSync(file.path, 'utf8')).d1_databases).toEqual([{ binding: 'DB', database_name: 'omni-mail-db' }])
    } finally { file.dispose() }
  })

  it('首次部署显式指定已有数据库时先验证 ID', async () => {
    const get = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([{ name: 'existing-db', uuid: boundId }])
    const target = await resolveDeploymentTarget({}, { environment, read: async () => config({ binding: 'DB', database_name: 'existing-db' }), get })
    expect(get).toHaveBeenLastCalledWith(databaseListPath('existing-db'))
    expect(target.databaseId).toBe(boundId)
  })

  it('多账户不会猜测默认目标', async () => {
    const loaded = config(); delete loaded.config.account_id
    await expect(resolveDeploymentTarget({}, { environment, read: async () => loaded, get: async () => [{ id: accountId }, { id: 'b'.repeat(32) }] }))
      .rejects.toThrow('无法唯一确定')
  })

  it('临时配置与源文件同目录，保留环境、相对资源路径及其他绑定', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omnimail-target-test-')); directories.push(directory)
    const path = join(directory, 'wrangler.jsonc')
    const original = '{"name":"omni-mail","main":"src/index.ts","compatibility_date":"2026-07-27","d1_databases":[{"binding":"DB"}],"assets":{"directory":"dist"},"env":{"staging":{"d1_databases":[{"binding":"DB","database_name":"wrong-name","migrations_dir":"migrations"}],"vars":{"PUBLIC_FLAG":"on"}}}}'
    writeFileSync(path, original)
    const target = await resolveDeploymentTarget({ config: path, env: 'staging' }, {
      environment: { CLOUDFLARE_ACCOUNT_ID: accountId }, get: async () => settings,
    })
    expect(target.workerName).toBe('omni-mail-staging')
    const file = writeDeploymentTarget(target)
    try {
      expect(dirname(file.path)).toBe(directory)
      const effective = await readDeploymentConfig({ config: file.path, env: 'staging' })
      expect(effective.config.name).toBe('omni-mail-staging')
      expect(effective.config.main).toBe(join(directory, 'src/index.ts'))
      expect(effective.config.d1_databases).toEqual([{ binding: 'DB', database_id: boundId, migrations_dir: 'migrations' }])
      expect(effective.config.vars).toEqual({ PUBLIC_FLAG: 'on' })
      expect(readFileSync(path, 'utf8')).toBe(original)
    } finally { file.dispose() }
    expect(existsSync(file.path)).toBe(false)
  })

  it('环境文件后者优先、进程环境优先，拒绝不明确的目标插值', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omnimail-env-test-')); directories.push(directory)
    const one = join(directory, 'one.env'), two = join(directory, 'two.env')
    writeFileSync(one, 'WRANGLER_CI_OVERRIDE_NAME=one\n')
    writeFileSync(two, 'WRANGLER_CI_OVERRIDE_NAME=two\n')
    const values = { 'env-file': [one, two] }
    expect(deploymentEnvironment(values, {}).WRANGLER_CI_OVERRIDE_NAME).toBe('two')
    expect(deploymentEnvironment(values, { WRANGLER_CI_OVERRIDE_NAME: 'three' }).WRANGLER_CI_OVERRIDE_NAME).toBe('three')
    expect(() => deploymentEnvironment(values, { WRANGLER_CI_OVERRIDE_NAME: '${WORKER}' })).toThrow('插值')
  })
})

describe('Cloudflare 只读目标查询', () => {
  const run = vi.fn(async () => JSON.stringify({ type: 'oauth', token: 'test-token-do-not-log' }))
  const retry = (operation: () => Promise<unknown>) => operation()
  it.each([401, 403, 404, 500])('HTTP %i 不能冒充首次部署', async (status) => {
    const get = await cloudflareReader({ profile: 'test' }, { run, retry,
      fetcher: async () => Response.json({ success: false, errors: [{ code: 10000, message: 'test-secret-must-not-appear' }] }, { status }),
    })
    await expect(get('/accounts/test/workers/scripts/test/settings')).rejects.toThrow(`HTTP ${status}`)
    await expect(get('/accounts/test/workers/scripts/test/settings')).rejects.not.toThrow('test-secret-must-not-appear')
    expect(run).toHaveBeenCalledWith(['auth', 'token', '--json', '--profile', 'test'], { capture: true, sensitive: true })
  })
  it('仅明确 10007 Worker 不存在返回首次创建信号', async () => {
    const get = await cloudflareReader({}, { run, retry,
      fetcher: async () => Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 }),
    })
    await expect(get('/accounts/test/workers/scripts/test/settings')).resolves.toBeNull()
  })
  it('只接受数据库详情的明确 7404 未找到，普通 404 仍报错', async () => {
    const get = await cloudflareReader({}, { run, retry,
      fetcher: async () => Response.json({ success: false, errors: [{ code: 7404 }] }, { status: 404 }),
    })
    await expect(get(`/accounts/${accountId}/d1/database/omni-mail-db`)).resolves.toBeNull()
    await expect(get(`/accounts/${accountId}/workers/scripts/omni-mail/settings`)).rejects.toThrow('HTTP 404')
  })
})
