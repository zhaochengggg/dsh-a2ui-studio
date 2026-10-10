/**
 * Shared validation and hashing for fixed read-only libvirt probes.
 *
 * @module dsh-machine-apps/machines/strategies/libvirt-readonly
 */

import { createHash } from 'node:crypto'

/** One labeled subprocess-output digest included in an aggregate observation digest. */
export interface LabeledOutputHash {
  readonly label: string
  readonly hash: string
}

/**
 * Hash labeled probe digests in stable order without retaining raw subprocess output.
 * @param scope - versioned observation namespace.
 * @param hashes - probe digests in execution order.
 * @returns lowercase SHA-256 digest.
 */
export function aggregateOutputHash(
  scope: string,
  hashes: readonly LabeledOutputHash[],
): string {
  const hash = createHash('sha256').update(scope).update('\0')
  for (const entry of hashes) hash.update(entry.label).update('\0').update(entry.hash).update('\0')
  return hash.digest('hex')
}

/**
 * Parse colon-delimited `virsh *-info` output.
 * @param output - bounded probe stdout.
 * @returns fields with blank keys and values omitted.
 */
export function parseKeyValueLines(output: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf(':')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key !== '' && value !== '') fields.set(key, value)
  }
  return fields
}

/**
 * Accept one libvirt object operand that is safe as a distinct argv element.
 * @param value - value parsed from a declaration or bounded libvirt output.
 * @returns whether the value is non-option, bounded, and free of control characters.
 */
export function safeVirshOperand(value: string): boolean {
  return value.length > 0
    && value.length <= 512
    && !value.startsWith('-')
    && !/[\u0000-\u001f\u007f]/u.test(value)
}
