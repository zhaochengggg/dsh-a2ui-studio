/** Explicit application declaration and execution failures. @module @deepseek-ai/dsh-app-cards/errors */

/** Stable code plus a human-readable operational failure. */
export class AppCardError extends Error {
  /** @param code - machine-readable failure. @param message - actionable diagnostic. */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AppCardError'
  }
}

/** Convert a thrown failure to a bounded result description.
 * @param error - failure reported by a dependency.
 * @returns its message without discarding the failure.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
