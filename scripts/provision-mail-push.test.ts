import { describe, it, expect, vi } from 'vitest'
import { provisionMailPushQueues } from './provision-mail-push.mjs'

const target = { accountId: 'fixture-account', rawConfig: { queues: { producers: [{ binding: 'MAIL_PUSH_QUEUE', queue: 'omnimail-mail-push' }] } } }
const retry = (operation: () => Promise<void>) => operation()
describe('mail push queue provisioning', () => {
  it('creates only missing dedicated queues using the resolved deployment target', async () => {
    const get = vi.fn(async (path: string) => path.endsWith('omnimail-mail-push') ? [{ queue_name: 'omnimail-mail-push' }] : [])
    const run = vi.fn()
    await provisionMailPushQueues(target, {}, 'resolved.json', { get, run, retry })
    expect(run).toHaveBeenCalledExactlyOnceWith(['queues', 'create', 'omnimail-mail-push-dead', '--config', 'resolved.json'])
  })
  it('does not create resources when inventory is unavailable or the binding is absent', async () => {
    const get = vi.fn().mockRejectedValue(new Error('Forbidden 403')), run = vi.fn()
    await expect(provisionMailPushQueues(target, {}, 'resolved.json', { get, run, retry })).rejects.toThrow('Forbidden')
    expect(run).not.toHaveBeenCalled()
    await provisionMailPushQueues({}, {}, 'resolved.json', { get, run, retry })
    expect(get).toHaveBeenCalledOnce()
  })
})
