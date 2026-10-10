import { describe, expect, it } from 'vitest'
import { AppCardNotifications } from '../src/notifications.ts'
import type { AppCardChange, MachineId } from '../src/types.ts'

function change(sequence: number): AppCardChange {
  return { machineId: 'machine' as MachineId, revision: 1, sequence, kind: 'run' }
}

/** Read frames until the predicate matches or the stream ends. */
async function take(
  stream: AsyncIterable<{ readonly frame: string; readonly change?: AppCardChange }>,
  count: number,
): Promise<{ readonly frame: string; readonly change?: AppCardChange }[]> {
  const frames: { readonly frame: string; readonly change?: AppCardChange }[] = []
  for await (const frame of stream) {
    frames.push(frame)
    if (frames.length === count) break
  }
  return frames
}

describe('application notification streams', () => {
  it('opens every stream with a reset frame before any committed change', async () => {
    const notifications = new AppCardNotifications({ maxClients: 8, maxPendingFrames: 8 })
    const abort = new AbortController()
    const stream = notifications.subscribe(abort.signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toEqual({ done: false, value: { frame: 'reset' } })
    notifications.publish(change(1))
    expect(await stream.next()).toEqual({ done: false, value: { frame: 'changed', change: change(1) } })
    abort.abort()
    await stream.return?.(undefined)
    notifications.dispose()
  })

  it('delivers each committed change to every open stream in commit order', async () => {
    const notifications = new AppCardNotifications({ maxClients: 2, maxPendingFrames: 8 })
    const abort = new AbortController()
    const first = take(notifications.subscribe(abort.signal), 3)
    const second = take(notifications.subscribe(abort.signal), 3)
    notifications.publish(change(1))
    notifications.publish(change(2))
    expect(await first).toEqual([
      { frame: 'reset' },
      { frame: 'changed', change: change(1) },
      { frame: 'changed', change: change(2) },
    ])
    expect(await second).toEqual([
      { frame: 'reset' },
      { frame: 'changed', change: change(1) },
      { frame: 'changed', change: change(2) },
    ])
    abort.abort()
    notifications.dispose()
  })

  it('refuses a stream beyond the configured limit without disturbing open streams', async () => {
    const notifications = new AppCardNotifications({ maxClients: 1, maxPendingFrames: 8 })
    const abort = new AbortController()
    const opened = notifications.subscribe(abort.signal)[Symbol.asyncIterator]()
    expect(await opened.next()).toEqual({ done: false, value: { frame: 'reset' } })
    await expect(notifications.subscribe(new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('limit')
    notifications.publish(change(1))
    expect(await opened.next()).toEqual({ done: false, value: { frame: 'changed', change: change(1) } })
    abort.abort()
    await opened.return?.(undefined)
    notifications.dispose()
  })

  it('releases capacity when a stream ends so a later stream can open', async () => {
    const notifications = new AppCardNotifications({ maxClients: 1, maxPendingFrames: 8 })
    const abort = new AbortController()
    const opened = notifications.subscribe(abort.signal)[Symbol.asyncIterator]()
    await opened.next()
    abort.abort()
    await opened.return?.(undefined)
    const reopened = notifications.subscribe(new AbortController().signal)[Symbol.asyncIterator]()
    expect(await reopened.next()).toEqual({ done: false, value: { frame: 'reset' } })
    await reopened.return?.(undefined)
    notifications.dispose()
  })

  it('ends open streams on disposal and refuses later subscriptions', async () => {
    const notifications = new AppCardNotifications({ maxClients: 4, maxPendingFrames: 8 })
    const stream = notifications.subscribe(new AbortController().signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toEqual({ done: false, value: { frame: 'reset' } })
    notifications.dispose()
    expect(await stream.next()).toEqual({ done: true, value: undefined })
    await expect(notifications.subscribe(new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('disposed')
    // Publication after disposal reaches no follower.
    notifications.publish(change(9))
  })

  it('refuses to open a stream whose signal is already aborted', async () => {
    const notifications = new AppCardNotifications({ maxClients: 4, maxPendingFrames: 8 })
    const abort = new AbortController()
    abort.abort()
    const stream = notifications.subscribe(abort.signal)[Symbol.asyncIterator]()
    await expect(stream.next()).rejects.toThrow()
    notifications.dispose()
  })

  it('fails a slow consumer at its queue limit while another consumer continues', async () => {
    const notifications = new AppCardNotifications({ maxClients: 2, maxPendingFrames: 1 })
    const slow = notifications.subscribe(new AbortController().signal)[Symbol.asyncIterator]()
    const fast = notifications.subscribe(new AbortController().signal)[Symbol.asyncIterator]()
    await slow.next()
    await fast.next()
    notifications.publish(change(1))
    expect((await fast.next()).value).toEqual({ frame: 'changed', change: change(1) })
    notifications.publish(change(2))
    await expect(slow.next()).rejects.toThrow('pending frame limit')
    expect((await fast.next()).value).toEqual({ frame: 'changed', change: change(2) })
    await fast.return?.()
    notifications.dispose()
  })

  it('cancels a pending read and releases its subscription before reopening', async () => {
    const notifications = new AppCardNotifications({ maxClients: 1, maxPendingFrames: 1 })
    const abort = new AbortController()
    const stream = notifications.subscribe(abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const pending = stream.next()
    abort.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    const next = notifications.subscribe(new AbortController().signal)[Symbol.asyncIterator]()
    expect((await next.next()).value).toEqual({ frame: 'reset' })
    await next.return?.()
    notifications.dispose()
  })
})
