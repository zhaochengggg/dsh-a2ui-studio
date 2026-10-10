/** Canonical JSON digests for immutable proposals. @module @deepseek-ai/dsh-app-cards/digest */

import { createHash } from 'node:crypto'
import type { CardDeclaration, ResolvedContext } from './types.ts'

/** Serialize JSON with deterministic object-key ordering.
 * @param value - JSON-compatible value.
 * @returns canonical JSON, rejecting non-JSON data.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  throw new TypeError('app-cards digest requires finite, plain JSON values')
}

/** Hash a JSON-compatible value.
 * @param value - exact immutable input.
 * @returns lowercase SHA-256.
 */
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** Hash the executable declaration without layout or presentation-only metadata.
 * @param declaration - candidate document.
 * @param contexts - independently resolved execution identities.
 * @returns authorization digest.
 */
export function executionDigest(
  declaration: CardDeclaration,
  contexts: Readonly<Record<string, ResolvedContext>>,
): string {
  return `sha256:${digest({
    executorVersion: 1,
    machineId: declaration.machineId,
    contexts,
    data: declaration.data,
    operations: declaration.operations,
    actions: declaration.actions,
    checks: declaration.checks,
    ...(declaration.monitoring ? {monitoring:declaration.monitoring} : {}),
  })}`
}
