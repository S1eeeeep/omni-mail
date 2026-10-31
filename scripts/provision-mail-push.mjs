// Workers Builds runs this with its existing deployment identity. Queue names
// are fixed; never infer or replace a mailbox database from a resource name.
export async function provisionMailPushQueues(target, values, configPath, { get, run, retry }) {
  const selected = values.env ? target.rawConfig?.env?.[values.env] : target.rawConfig
  if (!selected?.queues?.producers?.some((q) => q.binding === 'MAIL_PUSH_QUEUE' && q.queue === 'omnimail-mail-push')) return
  for (const name of ['omnimail-mail-push', 'omnimail-mail-push-dead']) {
    await retry(async () => {
      const queues = await get(`/accounts/${target.accountId}/queues?name=${encodeURIComponent(name)}`)
      if (!Array.isArray(queues)) throw new Error('推送队列查询返回无效，已停止部署。')
      const exact = queues.filter((q) => q.queue_name === name)
      if (exact.length > 1) throw new Error('推送队列名称不唯一，已停止部署。')
      if (exact.length === 1) return
      const args = ['queues', 'create', name, '--config', configPath]
      for (const key of ['env', 'env-file', 'profile']) {
        for (const value of values[key] === undefined ? [] : [].concat(values[key])) args.push(`--${key}`, value)
      }
      await run(args)
    }, { label: `配置队列 ${name}` })
  }
}
