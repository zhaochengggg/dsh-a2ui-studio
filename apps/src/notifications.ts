/** In-process change fan-out behind one Remote stream per subscribed Client. @module @deepseek-ai/dsh-app-cards/notifications */

import { Deque } from '../../vendor/deque.mjs'
import { AppCardError } from './errors.ts'
import type { AppCardChange, AppCardNotificationFrame } from './types.ts'

/** Deployment limit on concurrently open application notification streams. */
export interface NotificationOptions {
  readonly maxClients: number
  readonly maxPendingFrames: number
}

/** Fan out committed application changes to one queue per open Remote stream. */
export class AppCardNotifications {
  private readonly followers = new Set<AppCardFollower>()
  private disposed = false

  /** @param options - concurrent stream limit. */
  constructor(private readonly options: NotificationOptions) {}

  /** Open one stream that begins with a Client-side dedup reset.
   * @param signal - stream cancellation owned by the Remote carrier.
   * @returns reset followed by every change committed while the stream stays open.
   */
  async *subscribe(signal: AbortSignal): AsyncIterable<AppCardNotificationFrame> {
    if (this.disposed) throw new AppCardError('DISPOSED', 'Application notifications are disposed')
    if (this.followers.size >= this.options.maxClients) {
      throw new AppCardError('NOTIFICATION_CAPACITY', 'Application notification connection limit reached')
    }
    const follower = new AppCardFollower(this.options.maxPendingFrames)
    this.followers.add(follower)
    try {
      signal.throwIfAborted()
      yield { frame: 'reset' }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  /** Forward committed identities only; a frame never carries executable content.
   * @param change - application event after its storage commit.
   */
  publish(change: AppCardChange): void {
    if (this.disposed) return
    for (const follower of this.followers) follower.push({ frame: 'changed', change })
  }

  /** Close every open stream and refuse later subscriptions. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const follower of this.followers) follower.close()
    this.followers.clear()
  }
}

/** Bounded queue delivery for one open stream; a slow Client never blocks publication. */
class AppCardFollower {
  private readonly frames = new Deque<AppCardNotificationFrame>()
  private waiting: (() => void) | undefined
  private closed = false
  private failure: Error | undefined

  constructor(private readonly maxPendingFrames: number) {}

  /** @param frame - committed change or the opening reset. */
  push(frame: AppCardNotificationFrame): void {
    if (this.closed) return
    if (this.frames.size >= this.maxPendingFrames) {
      this.failure = new AppCardError('NOTIFICATION_OVERFLOW', 'Application notifications exceeded the pending frame limit; reconnect and reread state.')
      this.close()
      return
    }
    this.frames.pushBack(frame)
    this.waiting?.()
  }

  /** End the stream; a closed follower is removed before later publication can reach it. */
  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.frames.size > 0) this.frames.popFront()
    this.waiting?.()
  }

  /** @param signal - stream cancellation. @returns queued frames in commit order. */
  async *read(signal: AbortSignal): AsyncIterable<AppCardNotificationFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.popFront()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await this.wait(signal)
    }
    if (this.failure !== undefined) throw this.failure
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted || this.closed || this.frames.size > 0) finish()
    })
  }
}
