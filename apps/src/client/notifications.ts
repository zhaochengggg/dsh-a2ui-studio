/** Application invalidations supervised by the shared Gateway stream lifecycle. @module */

import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { AppCardNotificationFrame } from '../types.ts'
import type { AppCardsChanged } from './controller.ts'

/** Notifications reread authoritative state; they never invoke application checks. */
export interface NotificationConsumer {
  follow(signal: AbortSignal): AsyncIterable<AppCardNotificationFrame>
  reset(): void
  changed(change: AppCardsChanged): void
  failed(error: unknown): void
}

/** Open an application stream on the shared mux; Gateway owns carrier retries.
 * @param remote - the mounted Gateway's stream supervisor.
 * @param consumer - generated method and application read-model callbacks.
 * @returns disposer that cancels and drains the consumer.
 */
export function startNotifications(
  remote: Pick<ClientRemote, '$stream'>,
  consumer: NotificationConsumer,
): () => Promise<void> {
  const stream = remote.$stream<AppCardNotificationFrame>({
    name: 'Application notifications',
    open: signal => consumer.follow(signal),
    ended: () => new Error('Application notification source ended; reload the page to reconnect.'),
    carrierFailed: (error) => { consumer.failed(error) },
  })
  const lifetime = { disposed: false }
  const done = (async () => {
    let generation = 0
    try {
      for await (const item of stream) {
        if (item.generation !== generation) {
          if (item.value.frame !== 'reset') throw new Error('Application notifications require an opening reset.')
          consumer.reset()
          generation = item.generation
          item.accept()
        } else {
          if (item.value.frame !== 'changed') throw new Error('Application notifications sent a duplicate reset.')
          consumer.changed(item.value.change)
        }
      }
    } catch (error) {
      if (!lifetime.disposed) consumer.failed(error)
    }
  })()
  return async () => {
    lifetime.disposed = true
    await stream.dispose()
    await done
  }
}
