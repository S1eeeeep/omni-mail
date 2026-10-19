import { describe, expect, it, vi } from 'vitest'
import { deploy, deploymentOptions } from './deploy.mjs'
import { withRetry } from './wrangler-command.mjs'

const retry = (operation: () => Promise<unknown>, options: object) => withRetry(operation, {
  ...options, sleep: vi.fn(), warn: vi.fn(), random: () => 0,
})
const target = { workerName: 'omni-mail', workerExists: true, databaseId: 'bound-id' }
function dependencies() {
  const dispose = vi.fn()
  return {
    retry, makeReader: vi.fn(async () => vi.fn()), resolveTarget: vi.fn(async () => target),
    writeTarget: vi.fn(() => ({ path: 'resolved.json', dispose })), dispose,
  }
}

describe('部署入口', () => {
  it('已有 Worker 先解析实际绑定，再迁移和发布同一目标', async () => {
    const events: string[] = []
    const deps = dependencies()
    const migrate = vi.fn(async () => { events.push('migrate') })
    const run = vi.fn(async () => { events.push('deploy') })
    await deploy([], { ...deps, migrate, run })
    expect(events).toEqual(['migrate', 'deploy'])
    expect(migrate).toHaveBeenCalledWith({ configArgs: ['--config', 'resolved.json'] })
    expect(run).toHaveBeenCalledWith(['deploy', '--config', 'resolved.json'])
    expect(deps.dispose).toHaveBeenCalledOnce()
  })

  it.each([false, true])('首次部署后重新解析实际 ID，等待绑定可用再初始化（Worker 已存在：%s）', async (workerExists) => {
    const events: string[] = []
    const deps = dependencies()
    deps.resolveTarget.mockResolvedValueOnce({ ...target, workerExists, databaseId: undefined })
      .mockResolvedValueOnce({ ...target, workerExists, databaseId: undefined })
      .mockResolvedValue(target)
    await deploy([], { ...deps,
      migrate: async () => { events.push('migrate') }, run: async () => { events.push('deploy') },
    })
    expect(events).toEqual(['deploy', 'migrate'])
    expect(deps.resolveTarget).toHaveBeenCalledTimes(3)
    expect(deps.dispose).toHaveBeenCalledTimes(2)
  })

  it('资源已创建但绑定传播延迟时只重查绑定，不重复发布或创建数据库', async () => {
    const deps = dependencies()
    deps.resolveTarget.mockResolvedValueOnce({ ...target, databaseId: undefined })
      .mockRejectedValueOnce(new Error('已有 Worker 缺少有效的 DB 绑定，但账户中已存在 omni-mail-db。'))
      .mockResolvedValue(target)
    const run = vi.fn(), migrate = vi.fn()
    await deploy([], { ...deps, run, migrate })
    expect(run).toHaveBeenCalledOnce()
    expect(migrate).toHaveBeenCalledOnce()
    expect(deps.resolveTarget).toHaveBeenCalledTimes(3)
  })

  it.each(['Authentication error', 'SQLITE_ERROR', "Couldn't find an auto-provisioned D1 DB named 'omni-mail-db' for binding 'DB'"])(
    '迁移遇到 %s 时不尝试新建或发布替代数据库', async (message) => {
      const deps = dependencies()
      const run = vi.fn()
      await expect(deploy([], { ...deps, migrate: vi.fn().mockRejectedValue(new Error(message)), run })).rejects.toThrow(message)
      expect(run).not.toHaveBeenCalled()
      expect(deps.dispose).toHaveBeenCalledOnce()
    },
  )

  it('绑定缺失或权限拒绝时在任何写入前停止', async () => {
    const deps = dependencies()
    deps.resolveTarget.mockRejectedValue(new Error('线上绑定不可用'))
    const run = vi.fn(), migrate = vi.fn()
    await expect(deploy([], { ...deps, run, migrate })).rejects.toThrow('线上绑定不可用')
    expect(migrate).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(deps.writeTarget).not.toHaveBeenCalled()
  })

  it('首次发布后初始化失败，明确报告未完成并清理临时配置', async () => {
    const deps = dependencies()
    deps.resolveTarget.mockResolvedValueOnce({ ...target, workerExists: false, databaseId: undefined })
    const run = vi.fn()
    await expect(deploy([], { ...deps, run, migrate: vi.fn().mockRejectedValue(new Error('Forbidden HTTP 403')) }))
      .rejects.toThrow('Worker 已发布，但 D1 初始化未完成')
    expect(run).toHaveBeenCalledOnce()
    expect(deps.dispose).toHaveBeenCalledTimes(2)
  })

  it('上传临时失败时重试同一目标，不重复迁移', async () => {
    const deps = dependencies()
    const run = vi.fn().mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValue('ok')
    const migrate = vi.fn()
    await deploy([], { ...deps, run, migrate })
    expect(run).toHaveBeenCalledTimes(2)
    expect(migrate).toHaveBeenCalledOnce()
  })

  it('dry-run 不读取远端、不初始化、不迁移', async () => {
    const deps = dependencies()
    const run = vi.fn(), migrate = vi.fn()
    await deploy(['--dry-run', '--outdir', '.wrangler/preview'], { ...deps, run, migrate })
    expect(deps.makeReader).not.toHaveBeenCalled()
    expect(migrate).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledExactlyOnceWith(['deploy', '--dry-run', '--outdir', '.wrangler/preview'])
  })

  it('保留环境和登录配置，但迁移、发布都使用解析后的配置路径', async () => {
    const deps = dependencies()
    const args = ['--env', 'staging', '--config', 'staging.jsonc', '--env-file', '.env.staging', '--profile', 'test', '--minify']
    const migrate = vi.fn(), run = vi.fn()
    await deploy(args, { ...deps, migrate, run })
    const common = ['--config', 'resolved.json', '--env', 'staging', '--env-file', '.env.staging', '--profile', 'test']
    expect(migrate).toHaveBeenCalledWith({ configArgs: common })
    expect(run).toHaveBeenCalledWith(['deploy', ...common, '--minify'])
  })

  it('未知目标覆盖或无效参数在任何操作前报错', async () => {
    expect(() => deploymentOptions(['--env', '\n'])).toThrow('无效')
    const deps = dependencies(), run = vi.fn(), migrate = vi.fn()
    await expect(deploy(['--name', 'other-worker'], { ...deps, run, migrate })).rejects.toThrow()
    expect(deps.makeReader).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})
