/** Translate owned failures only at Remote entry; stored and model-facing errors keep their codes. @module */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { AppCardError } from './errors.ts'
import type {} from './types.ts'

function rethrow(error: unknown): never {
  if (error instanceof AppCardError) {
    throw new RemoteError('app-cards/rejected', error.message, { code: error.code }, { cause: error })
  }
  throw error
}

/** Preserve synchronous Remote methods while adapting their owned failures.
 * @param operation - read or cancellation performed by the application service.
 * @returns the unchanged business result.
 */
export function remoteValue<T>(operation: () => T): T {
  try { return operation() } catch (error) { return rethrow(error) }
}

/** Adapt rejected asynchronous application requests without masking unexpected failures.
 * @param operation - application request to await.
 * @returns the unchanged business result.
 */
export async function remoteCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() } catch (error) { return rethrow(error) }
}

/** Adapt both stream opening and iteration failures; cancellation still belongs to the carrier.
 * @param open - source factory opened when consumption starts.
 * @returns the same frames with owned failures encoded as Remote errors.
 */
export async function* remoteStream<T>(open: () => AsyncIterable<T>): AsyncIterable<T> {
  try { yield* open() } catch (error) { rethrow(error) }
}
