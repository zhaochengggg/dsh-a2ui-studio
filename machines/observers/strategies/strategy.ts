/**
 * Capability-rich read-only machine strategy contract.
 *
 * @module dsh-machine-apps/machines/strategies/strategy
 */

import type {
  MachineCapability,
  MachineDescriptor,
  MachineFact,
  MachineId,
  MachineReachability,
  MachineSshPathId,
  MachineStrategyKind,
} from '../types.ts'

/** Resolved target passed to one strategy without granting mutation authority. */
export interface StrategyTarget {
  readonly id: MachineId
  readonly displayName: string
  readonly kind: MachineStrategyKind
  readonly descriptor?: MachineDescriptor
  readonly pathId?: MachineSshPathId
}

/** Fixed executable prerequisite probe. */
export interface StrategyPrerequisites {
  readonly available: boolean
  readonly reason: string
  readonly evidence?: string
  readonly outputHash?: string
}

/** Normalized facts returned by a read-only strategy inspection. */
export interface StrategyInspection {
  readonly reachability: MachineReachability
  /** SSH path used by this observation; absent for non-SSH strategies. */
  readonly pathId?: MachineSshPathId
  /** Bounded normalized facts; raw subprocess output is never retained here. */
  readonly summary: string
  /** Bounded display facts in stable presentation order when the strategy provides them. */
  readonly facts?: readonly MachineFact[] | undefined
  /** Aggregate digest of the bounded raw probe streams. */
  readonly outputHash?: string
  readonly capabilities: readonly MachineCapability[]
}

/**
 * A strategy validates declarations, probes prerequisites, reports capabilities,
 * and performs bounded read-only inspection. Mutation execution is intentionally absent.
 */
export interface MachineStrategy {
  readonly kind: MachineStrategyKind
  /**
   * Validate strategy-specific relationships after the common catalog schema.
   * @param descriptor - validated catalog declaration.
   * @returns diagnostic messages; an empty list accepts the declaration.
   */
  validateDescriptor(descriptor: MachineDescriptor): readonly string[]
  /**
   * Probe fixed local prerequisites without contacting the target.
   * @param signal - caller cancellation.
   * @returns current executable availability.
   */
  probePrerequisites(signal?: AbortSignal): Promise<StrategyPrerequisites>
  /**
   * Observe a target without changing it.
   * @param target - resolved declared or transient target.
   * @param signal - caller cancellation.
   * @returns normalized reachability and capability facts.
   */
  inspect(target: StrategyTarget, signal?: AbortSignal): Promise<StrategyInspection>
  /**
   * Describe all known operations honestly for the current prerequisites.
   * @param target - resolved target.
   * @param prerequisites - optional fresh prerequisite result.
   * @returns complete capability rows.
   */
  capabilities(
    target: StrategyTarget,
    prerequisites?: StrategyPrerequisites,
  ): readonly MachineCapability[]
}

/** Every capability name in stable display order. */
export const MACHINE_CAPABILITY_NAMES = [
  'inspect',
  'provision',
  'delete',
  'power.start',
  'power.shutdown',
  'power.reboot',
  'power.forceOff',
  'config.cpu',
  'config.memory',
  'config.storage',
  'config.network',
  'snapshot.offline',
  'snapshot.live',
  'metrics.read',
] as const satisfies readonly MachineCapability['name'][]
