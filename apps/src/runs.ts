/** Owned execution queues, receipts, check evidence and quiescent shutdown. @module */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod/v3'
import { AppAgentRunner } from './agent-runner.ts'
import type { ResolvedConfig } from './config.ts'
import { resolveContexts } from './contexts.ts'
import { executionDigest } from './digest.ts'
import { AppCardError, errorMessage } from './errors.ts'
import { executeOperation, type ExecutionEnvironment } from './executor.ts'
import { evaluateExpression } from './expression.ts'
import type { AppCardStore } from './store.ts'
import type { AppCardChange, CardDeclaration, CheckObservation, JsonValue, MachineId, OperationResult, RunId, RunRecord } from './types.ts'

/** Declaration and execution identities read from the authoritative grant store. */
export type AuthorizedDeclaration = NonNullable<Awaited<ReturnType<AppCardStore['current']>>>

/** Publication policy rechecked immediately before each executable step. */
export interface RunOwner {
  current(machineId: MachineId, revision: number): Promise<AuthorizedDeclaration>
  changed(machineId: MachineId, kind: AppCardChange['kind']): void
}

/** Own accepted work from its precommitted receipt until its result has been persisted. */
export class AppCardRuns {
  private readonly running = new Map<RunId, { controller: AbortController; task: Promise<void>; machineId: MachineId }>()
  private readonly machineTails = new Map<MachineId, Promise<void>>()
  private readonly persistenceFailures = new Map<RunId, { machineId: MachineId; message: string }>()
  private readonly agentRunner: AppAgentRunner
  private activeCount = 0
  private readonly waiting: (() => void)[] = []

  /** @param ctx - injected subprocess, machine and Agent services.
   * @param store - receipts and evidence owned by the parent service.
   * @param config - resolved deployment policy.
   * @param owner - current grant validation and committed-state notifications.
   */
  constructor(
    private readonly ctx: Context,
    private readonly store: AppCardStore,
    private readonly config: ResolvedConfig,
    private readonly owner: RunOwner,
  ) {
    this.agentRunner = new AppAgentRunner(ctx, config.dataPath, config.executionTimeoutMs,
      config.agentProvider !== undefined && config.agentModel !== undefined
        ? { provider: config.agentProvider, model: config.agentModel } : {})
  }

  /** Refuse admission before allocating another durable request identity. */
  assertCapacity(): void {
    if (this.running.size >= this.config.maxPendingRuns) throw new AppCardError('RUN_CAPACITY', 'Application execution queue is full')
  }

  /** Refuse a machine view with an uncommitted execution result.
   * @param machineId - selected machine.
   */
  assertMachineReadable(machineId: MachineId): void {
    for (const failure of this.persistenceFailures.values()) {
      if (failure.machineId === machineId) throw new AppCardError('RESULT_PERSISTENCE', failure.message)
    }
  }

  /** Read a receipt without concealing a failed result commit.
   * @param runId - validated invocation identity.
   * @returns the persisted receipt.
   */
  read(runId: RunId): RunRecord {
    const failure = this.persistenceFailures.get(runId)
    if (failure !== undefined) throw new AppCardError('RESULT_PERSISTENCE', failure.message)
    return this.store.run(runId)
  }

  /** Read the settling task used to retain in-flight check deduplication.
   * @param runId - admitted receipt.
   * @returns the owned task while it is pending.
   */
  task(runId: RunId): Promise<void> | undefined { return this.running.get(runId)?.task }

  /** Request cancellation without claiming rollback of remote effects.
   * @param runId - admitted receipt.
   */
  cancel(runId: RunId): void { this.running.get(runId)?.controller.abort() }

  /** Cancel work invalidated by a new executable declaration or removal.
   * @param machineId - changed declaration owner.
   */
  cancelMachine(machineId: MachineId): void {
    for (const run of this.running.values()) if (run.machineId === machineId) run.controller.abort()
  }

  /** Start precommitted work; actions serialize per machine, all work shares one concurrency budget.
   * @param run - newly admitted receipt.
   * @param current - immutable declaration and matching grant.
   * @param operationId - declared operation.
   * @param exclusive - whether to queue behind this machine's previous action.
   * @param clientDriven - whether a top-level Agent operation awaits browser prompt submission.
   */
  launch(run: RunRecord, current: AuthorizedDeclaration, operationId: string, exclusive: boolean, clientDriven = false): void {
    const controller = new AbortController()
    const previous = this.machineTails.get(run.machineId) ?? Promise.resolve()
    const limited = async (): Promise<void> => {
      if (this.activeCount >= this.config.concurrency) await new Promise<void>((resolve) => { this.waiting.push(resolve) })
      else this.activeCount++
      try { await this.execute(run, current, operationId, controller.signal, clientDriven) } finally {
        const next = this.waiting.shift()
        if (next === undefined) this.activeCount--
        else next()
      }
    }
    const task = (exclusive ? previous : Promise.resolve()).then(limited).finally(() => {
      this.running.delete(run.id)
      if (this.machineTails.get(run.machineId) === task) this.machineTails.delete(run.machineId)
    })
    this.running.set(run.id, { controller, task, machineId: run.machineId })
    if (exclusive) this.machineTails.set(run.machineId, task)
  }

  /** Cancel and drain every run and submitted Agent before the service closes storage. */
  async dispose(): Promise<void> {
    for (const run of this.running.values()) run.controller.abort()
    await Promise.all([...this.running.values()].map(run => run.task))
    await this.agentRunner.dispose()
  }

  private async execute(
    run: RunRecord, current: AuthorizedDeclaration, operationId: string, signal: AbortSignal, clientDriven: boolean,
  ): Promise<void> {
    let result: OperationResult
    try {
      signal.throwIfAborted()
      this.store.start(run.id)
      this.owner.changed(run.machineId, 'run')
      const environment: ExecutionEnvironment = {
        subprocess: this.ctx.subprocess, contexts: current.contexts, signal,
        limits: {
          timeoutMs: this.config.executionTimeoutMs, outputLimitBytes: this.config.outputLimitBytes,
          graceMs: this.config.graceMs, concurrency: this.config.concurrency,
        },
        beforeStep: async () => {
          const live = await this.owner.current(run.machineId, run.revision)
          const contexts = await resolveContexts(live.declaration, this.ctx.machineMgmt, this.config.hostRoots, this.config.maxJsonBytes)
          if (executionDigest(live.declaration, contexts) !== live.executionDigest) {
            throw new AppCardError('CONTEXT_CHANGED', 'The authorized execution context changed; no operation was started')
          }
          signal.throwIfAborted()
        },
        runAgent: (operation, input, taskSignal) => this.agentRunner.run(operation, input, taskSignal,
          (id, value, nestedSignal) => executeOperation(current.declaration, id, value, { ...environment, signal: nestedSignal }),
          clientDriven && current.declaration.operations[operationId] === operation
            ? {
              prepare: (sessionId, text) => { this.store.preparePrompt(run.id, { sessionId, text }); this.owner.changed(run.machineId, 'run') },
              claim: () => { this.store.claimPrompt(run.id); this.owner.changed(run.machineId, 'run') },
            }
            : undefined),
      }
      result = await executeOperation(current.declaration, operationId, run.input, environment)
    } catch (error) {
      result = {
        state: signal.aborted ? 'cancelled' : 'failed', value: null,
        error: { code: error instanceof AppCardError ? error.code : 'EXECUTION_FAILED', message: errorMessage(error) },
      }
    }
    try {
      this.store.finish(run.id, result)
      if (run.kind === 'check') await this.finishCheck(run, current.declaration, result)
      this.owner.changed(run.machineId, run.kind === 'check' ? 'observation' : 'run')
    } catch (error) {
      const message = `app-cards run ${run.id}: result persistence failed: ${errorMessage(error)}`
      this.persistenceFailures.set(run.id, { machineId: run.machineId, message })
      this.ctx.logger.error(message)
      this.owner.changed(run.machineId, 'run')
    }
  }

  private async finishCheck(run: RunRecord, declaration: CardDeclaration, result: OperationResult): Promise<void> {
    const check = declaration.checks[run.entryId]
    if (check === undefined) throw new AppCardError('CHECK_MISSING', 'Check disappeared from its locked declaration')
    const now = Date.now()
    let observation: CheckObservation = {
      checkId: run.entryId, revision: run.revision, runId: run.id, observedAt: now,
      expiresAt: now + check.freshForMs, health: 'unknown', summary: '检查未能完成',
      value: result.value, stale: false,
    }
    if (result.state === 'succeeded') {
      try {
        const evaluated = await evaluateExpression(check.evaluate.source, JSON.parse(JSON.stringify(result)) as JsonValue, {
          timeoutMs: this.config.executionTimeoutMs, outputLimitBytes: this.config.outputLimitBytes,
        })
        const value = z.object({
          health: z.enum(['healthy', 'unhealthy', 'unknown']), summary: z.string(),
        }).passthrough().parse(evaluated)
        observation = { ...observation, health: value.health, summary: value.summary, value: evaluated }
      } catch (error) {
        observation = { ...observation, error: errorMessage(error) }
      }
    } else observation = { ...observation, error: result.error?.message ?? `Check ${result.state}` }
    this.store.observe(run.machineId, observation)
  }
}
