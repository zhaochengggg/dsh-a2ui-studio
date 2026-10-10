import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteStream, RemoteStreamCarrierError } from '../../tests/gateway-runtime.mjs'
import type {ClientRemote} from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { startNotifications } from '../src/client/notifications.ts'
import type { AppCardNotificationFrame, MachineId } from '../src/types.ts'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose() })

const remote: Pick<ClientRemote, '$stream'> = {
  $stream: options => new RemoteStream({
    generation: {
      getSnapshot: () => ({ id: 1, host: { home: '/fixture' } }),
      subscribe: () => () => {},
    },
  }, options),
}

const change = { machineId: 'machine' as MachineId, revision: 1, sequence: 2, kind: 'run' as const }

function hold(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

describe('Gateway-owned application notification lifecycle', () => {
  it('rereads each new generation and delegates physical retry without running checks', async () => {
    let generation = 0
    const reset = vi.fn()
    const changed = vi.fn()
    const failed = vi.fn()
    const closed = vi.fn()
    disposers.push(startNotifications(remote, {
      async *follow(signal) {
        generation++
        try {
          yield { frame: 'reset' }
          yield { frame: 'changed', change }
          if (generation === 1) throw new RemoteStreamCarrierError('connection lost')
          await hold(signal)
        } finally {
          closed()
        }
      },
      reset, changed, failed,
    }))
    await vi.waitFor(() => { expect(reset).toHaveBeenCalledTimes(2) })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith(change)
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'connection lost' }))
    await disposers[0]!()
    expect(closed).toHaveBeenCalledTimes(2)
    expect(failed).toHaveBeenCalledOnce()
  })

  it.each([
    [[{ frame: 'changed', change }], 'opening reset'],
    [[{ frame: 'reset' }, { frame: 'reset' }], 'duplicate reset'],
    [[], 'source ended'],
  ] satisfies [AppCardNotificationFrame[], string][])('reports invalid generation ordering without retrying', async (frames, message) => {
    const failed = vi.fn()
    const changed = vi.fn()
    const follow = vi.fn(async function*() { yield* frames })
    disposers.push(startNotifications(remote, { follow, reset: vi.fn(), changed, failed }))
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
    expect((failed.mock.calls[0]?.[0] as Error).message).toContain(message)
    expect(changed).not.toHaveBeenCalled()
    expect(follow).toHaveBeenCalledOnce()
  })

  it('surfaces a business refusal once rather than retrying it as a transport failure', async () => {
    const failed = vi.fn()
    const refusal = new RemoteError('gateway/bad-request', 'stream capacity exceeded', {})
    const follow = vi.fn((_signal: AbortSignal): AsyncIterable<AppCardNotificationFrame> => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(refusal) }),
    }))
    disposers.push(startNotifications(remote, { follow, reset: vi.fn(), changed: vi.fn(), failed }))
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledExactlyOnceWith(refusal) })
    expect(follow).toHaveBeenCalledOnce()
  })

  it('waits for the active generation to close during disposal', async () => {
    const started = Promise.withResolvers<undefined>()
    const closing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const failed = vi.fn()
    const dispose = startNotifications(remote, {
      async *follow(signal) {
        yield { frame: 'reset' }
        started.resolve(undefined)
        await hold(signal)
        closing.resolve(undefined)
        await release.promise
      },
      reset: vi.fn(), changed: vi.fn(), failed,
    })
    disposers.push(dispose)
    await started.promise
    let done = false
    const pending = dispose().then(() => { done = true })
    await closing.promise
    expect(done).toBe(false)
    release.resolve(undefined)
    await pending
    expect(done).toBe(true)
    expect(failed).not.toHaveBeenCalled()
  })
})
