/** Application deployment policy resolved once before opening storage. @module */

import { isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { AppCardError } from './errors.ts'

/** Explicit private storage and bounded execution settings. */
export interface Config {
  /** Absolute owner-only directory for declarations, authorizations and receipts. */
  readonly dataPath: string
  /** Local working-directory roots the deployment allows application operations to use. */
  readonly hostRoots?: string[]
  /** Maximum UTF-8 bytes in a complete JSON declaration, review or stored record. */
  readonly maxJsonBytes?: number
  /** Maximum recent receipts returned per machine. */
  readonly historyLimit?: number
  /** Milliseconds SQLite waits for a competing writer. */
  readonly busyTimeoutMs?: number
  /** Millisecond ceiling applied to declared operation deadlines. */
  readonly executionTimeoutMs?: number
  /** Byte ceiling for collected output and complete operation results. */
  readonly outputLimitBytes?: number
  /** Milliseconds between graceful process termination and escalation. */
  readonly graceMs?: number
  /** Maximum concurrently running top-level tasks and per-flow leaf operations. */
  readonly concurrency?: number
  /** Cooperative millisecond deadline for the human publication-review tool. */
  readonly reviewTimeoutMs?: number
  /** Maximum admitted runs, including queued work. */
  readonly maxPendingRuns?: number
  /** Explicit application-task provider; must be supplied together with agentModel. */
  readonly agentProvider?: string
  /** Explicit application-task model; must be supplied together with agentProvider. */
  readonly agentModel?: string
  /** Maximum concurrently open notification streams. */
  readonly maxNotificationClients?: number
  /** Maximum queued invalidations per Client before its stream fails and requires a reread. */
  readonly maxPendingNotificationFrames?: number
}

/** Complete policy shared by publication, execution and notification owners. */
export type ResolvedConfig = Required<Omit<Config, 'agentProvider' | 'agentModel'>>
  & Pick<Config, 'agentProvider' | 'agentModel'>

/** Loader validation and the single source of deployment defaults. */
export const Config: z<Config, ResolvedConfig> = z.object({
  dataPath: z.string(),
  hostRoots: z.array(z.string()).default([]),
  maxJsonBytes: z.number().min(1024).step(1).default(262144),
  historyLimit: z.number().min(1).step(1).default(25),
  busyTimeoutMs: z.number().min(0).step(1).default(5000),
  executionTimeoutMs: z.number().min(1).step(1).default(60000),
  outputLimitBytes: z.number().min(1).step(1).default(65536),
  graceMs: z.number().min(1).step(1).default(1000),
  concurrency: z.number().min(1).max(16).step(1).default(4),
  reviewTimeoutMs: z.number().min(1).step(1).default(600000),
  maxPendingRuns: z.number().min(1).step(1).default(128),
  agentProvider: z.string(),
  agentModel: z.string(),
  maxNotificationClients: z.number().min(1).step(1).default(64),
  maxPendingNotificationFrames: z.number().min(1).step(1).default(128),
})

/** Resolve path and paired-model policy before acquiring resources.
 * @param input - deployment config accepted by the Loader or direct plugin construction.
 * @returns validated config with defaults and a detached host-root list.
 */
export function resolveConfig(input: Config): ResolvedConfig {
  if (!input.dataPath || !isAbsolute(input.dataPath)) throw new AppCardError('CONFIG', 'app-cards requires an absolute dataPath')
  const config = Config(input)
  for (const root of config.hostRoots) {
    if (!isAbsolute(root)) throw new AppCardError('CONFIG', 'Every app-cards hostRoot must be absolute')
  }
  if ((config.agentProvider === undefined) !== (config.agentModel === undefined)) {
    throw new AppCardError('CONFIG', 'agentProvider and agentModel must be configured together')
  }
  return { ...config, dataPath: resolve(config.dataPath), hostRoots: [...config.hostRoots] }
}
