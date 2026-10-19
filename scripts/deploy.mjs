import { parseArgs } from 'node:util'
import { applyD1Migrations } from './apply-d1-migrations.mjs'
import { isMainModule, reportFailure, runWrangler, withRetry } from './wrangler-command.mjs'
import { cloudflareReader, resolveDeploymentTarget, targetArguments, writeDeploymentTarget } from './deployment-target.mjs'

export function deploymentOptions(args) {
  // 只接收能同时安全传给迁移与部署的目标参数，避免 --name 等覆盖项导致两个操作指向不同资源。
  const { values } = parseArgs({
    args,
    options: {
      env: { type: 'string', short: 'e' },
      config: { type: 'string', short: 'c' },
      'env-file': { type: 'string', multiple: true },
      profile: { type: 'string' },
      'dry-run': { type: 'boolean' },
      outdir: { type: 'string' },
      minify: { type: 'boolean' },
    },
  })
  for (const [key, value] of Object.entries(values)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry === 'string'
        && (!entry.trim() || entry.length > 4096 || /[\0\r\n]/.test(entry))) {
        throw new Error(`无效的 --${key} 参数。`)
      }
    }
  }
  const configArgs = []
  for (const key of ['env', 'config', 'env-file', 'profile']) {
    const value = values[key]
    if (value === undefined) continue
    for (const entry of Array.isArray(value) ? value : [value]) {
      configArgs.push(`--${key}`, entry)
    }
  }
  return { configArgs, dryRun: values['dry-run'] === true, values }
}

export async function deploy(args = [], {
  run = runWrangler,
  migrate = applyD1Migrations,
  retry = withRetry,
  resolveTarget = resolveDeploymentTarget,
  makeReader = cloudflareReader,
  writeTarget = writeDeploymentTarget,
} = {}) {
  const { values, dryRun } = deploymentOptions(args)
  if (dryRun) {
    await run(['deploy', ...args])
    return
  }
  const get = await makeReader(values, { run, retry })
  let target = await resolveTarget(values, { get })
  const files = []
  const write = () => { const file = writeTarget(target); files.push(file); return file.path }
  const publish = (path) => retry(() => run(['deploy', ...targetArguments(values, path, true)]), { label: 'Worker 部署' })
  try {
    // 目标解析已核对建库条件；Cloudflare 预先创建的空 Worker 也需要先配置资源再迁移。
    if (!target.databaseId) {
      console.log(`首次部署：为 ${target.workerName} 创建资源绑定。`)
      await publish(write())
      try {
        // 首次创建后重新读取绑定 ID，不能再次按 Worker 名称猜数据库名。
        target = await retry(async () => {
          const current = await resolveTarget(values, { get })
          if (!current.workerExists || !current.databaseId) throw new Error('新建 Worker 绑定暂未可用。')
          return current
        }, { label: '等待新建 D1 绑定', shouldRetry: (error) => /新建 Worker 绑定暂未可用|已有 Worker 缺少有效的 DB 绑定/.test(error.message) })
        await migrate({ configArgs: targetArguments(values, write()) })
      } catch (error) {
        throw new Error(`Worker 已发布，但 D1 初始化未完成。请修复原因后重新运行 npm run deploy：\n${error.message}`)
      }
      console.log('首次部署完成，D1 迁移校验通过。')
      return
    }
    const path = write()
    console.log(`已定位 ${target.workerName} 的 DB 绑定，正在检查并迁移 D1……`)
    await migrate({ configArgs: targetArguments(values, path) })
    await publish(path)
    console.log('部署完成，D1 迁移校验通过。')
  } finally {
    for (const file of files) file.dispose()
  }
}

if (isMainModule(import.meta.url)) {
  await deploy(process.argv.slice(2)).catch(reportFailure)
}
