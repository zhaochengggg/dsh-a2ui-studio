/** Application resource publication invariants. @module @deepseek-ai/dsh-app-cards/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type {} from './types.ts'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Companion plugin identity. */
export const name = 'app-cards-invariant'
/** Required invariant registry. */
export const inject = ['invariants']

const install: InvariantInstaller = (ctx, fail) => {
  const versions = new Map<string, { revision: number; sequence: number }>()
  ctx.on('app-cards/changed', (change) => {
    const previous = versions.get(change.machineId)
    if (previous !== undefined && (change.revision < previous.revision || change.sequence < previous.sequence)) {
      fail('application resource publication moved its revision or sequence backwards')
    }
    versions.set(change.machineId, change)
  }, { global: true })
}

/** Register the application publication invariant.
 * @param ctx - invariant-enabled context.
 * @returns effect-owned disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-app-cards', install))
