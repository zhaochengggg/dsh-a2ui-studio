import { describe, expect, it } from 'vitest'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { AppCardError } from '../src/errors.ts'
import { AppCardNotifications } from '../src/notifications.ts'
import { remoteCall, remoteStream, remoteValue } from '../src/remote-errors.ts'
import type { MachineId } from '../src/types.ts'

describe('application Remote failures', () => {
  it('preserves values and translates only owned failures, without modifying the local code', async () => {
    const value = { revision: 1 }
    expect(remoteValue(() => value)).toBe(value)
    expect(await remoteCall(() => Promise.resolve(value))).toBe(value)
    const local = new AppCardError('REVISION_CONFLICT', 'Reload the declaration')
    const refuse = (): never => { throw local }
    try {
      remoteValue(refuse)
      expect.unreachable()
    } catch (error) {
      expect(remoteErrorOf(error)).toMatchObject({
        code: 'app-cards/rejected', details: { code: 'REVISION_CONFLICT' },
        message: local.message, cause: local,
      })
    }
    expect(local.code).toBe('REVISION_CONFLICT')
    await expect(remoteCall(async () => refuse())).rejects.toMatchObject({
      code: 'app-cards/rejected', details: { code: local.code },
    })
  })

  it('does not label programming or dependency failures as application refusals', async () => {
    for (const failure of [new TypeError('unexpected failure'), new RemoteError('gateway/cancelled', 'cancelled', {})]) {
      const refuse = (): never => { throw failure }
      try { remoteValue(refuse); expect.unreachable() } catch (error) { expect(error).toBe(failure) }
      await expect(remoteCall(async () => refuse())).rejects.toBe(failure)
      await expect(remoteStream(refuse)[Symbol.asyncIterator]().next()).rejects.toBe(failure)
    }
  })

  it('encodes admission and mid-stream overflow without reclassifying carrier cancellation', async () => {
    const source = new AppCardNotifications({ maxClients: 1, maxPendingFrames: 1 })
    const abort = new AbortController()
    const stream = remoteStream(() => source.subscribe(abort.signal))[Symbol.asyncIterator]()
    try {
      expect((await stream.next()).value).toEqual({ frame: 'reset' })
      await expect(remoteStream(() => source.subscribe(abort.signal))[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        code: 'app-cards/rejected', details: { code: 'NOTIFICATION_CAPACITY' },
      })
      for (const sequence of [1, 2]) source.publish({ machineId: 'm' as MachineId, revision: 1, sequence, kind: 'run' })
      await expect(stream.next()).rejects.toMatchObject({
        code: 'app-cards/rejected', details: { code: 'NOTIFICATION_OVERFLOW' },
      })
      const reopened = remoteStream(() => source.subscribe(abort.signal))[Symbol.asyncIterator]()
      await reopened.next()
      const next = reopened.next()
      abort.abort()
      expect(await next).toEqual({ done: true, value: undefined })
    } finally {
      abort.abort()
      await stream.return?.()
      source.dispose()
    }
  })
})
