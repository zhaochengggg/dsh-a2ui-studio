/** Opt-in application declarations, human authorization and operation ownership. @module @deepseek-ai/dsh-app-cards */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { MachineId } from '../../machines/contracts.ts'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '../../machines/contracts.ts'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { Config, resolveConfig, type ResolvedConfig } from './config.ts'
import { AppCardRuns } from './runs.ts'
import { resolveContexts } from './contexts.ts'
import { parseDeclaration, resolveBinding } from './declaration.ts'
import { canonicalJson, digest, executionDigest } from './digest.ts'
import { AppCardError } from './errors.ts'
import { evaluateExpression } from './expression.ts'
import { buildReview } from './review.ts'
import { AppCardStore } from './store.ts'
import { registerAppTools } from './tools.ts'
import { registerPackagedSkill } from './skill.ts'
import { validateUi } from './ui-catalog.ts'
import { AppCardNotifications } from './notifications.ts'
import { remoteCall, remoteStream, remoteValue } from './remote-errors.ts'
import {DynamicExtensions,registerExtensionRoutes} from './extensions/dynamic-host.ts'
import {setDynamicProvider} from './extensions/dynamic-schema.ts'
import {join} from 'node:path'
import type {
  AppCardNotificationFrame, CardProposal, CardSnapshot, ProposalId, RequestId, RunId, RunRecord,
} from './types.ts'

export type * from './types.ts'
export type { Config } from './config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Published application cards and their authorized runs. */
    appCards: AppCardsService
  }
}

/** Host service; only human review can publish executable declarations. */
export class AppCardsService extends TypertRemoteService {
  static inject = ['machineMgmt', 'subprocess', 'tools', 'skills', 'agents', 'userQuestions']
  static Config = Config

  private readonly config: ResolvedConfig
  private store!: AppCardStore
  private runs!: AppCardRuns
  private readonly admissions = new Map<MachineId, Promise<void>>()
  private readonly checking = new Map<string, Promise<RunRecord>>()
  private closed = false
  private notifications: AppCardNotifications | undefined
  private extensions!: DynamicExtensions

  /** @param ctx - Host composition. @param config - deployment configuration. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'appCards')
    this.config = resolveConfig(config)
    for (const name of ['read','invoke','refresh','readRun','cancel','preview','subscribe']) {
      const decorator = name === 'subscribe' ? Remote({mode:'stream'}) : Remote
      decorator(undefined, {kind:'method',name,addInitializer: fn => fn.call(this)})
    }
  }

  /** Open storage and register model consumers without publishing or executing declarations. */
  protected async [Service.init](): Promise<void> {
    this.extensions=new DynamicExtensions(join(this.config.dataPath,'extensions'))
    this.extensions.read()
    setDynamicProvider(()=>this.extensions.packages())
    this.ctx.effect(()=>()=>setDynamicProvider(()=>[]),'app-cards: extension catalog')
    registerExtensionRoutes(this.ctx,this.extensions)
    await registerPackagedSkill(this.ctx)
    this.store = await AppCardStore.open(this.config)
    this.runs = new AppCardRuns(this.ctx, this.store, this.config, {
      current: (id, revision) => this.requireCurrent(id, revision),
      changed: (id, kind) => { this.notify(id, kind) },
    })
    const notifications = new AppCardNotifications({
      maxClients: this.config.maxNotificationClients,
      maxPendingFrames: this.config.maxPendingNotificationFrames,
    })
    this.notifications = notifications
    this.ctx.on('app-cards/changed', (change) => { notifications.publish(change) })
    this.ctx.effect(() => () => {
      notifications.dispose()
      if (this.notifications === notifications) this.notifications = undefined
    }, 'app-cards: close notification streams')
    this.ctx.effect(() => async () => {
      this.closed = true
      await this.runs.dispose()
      this.store.close()
    }, 'app-cards: drain execution and close storage')
    registerAppTools(this.ctx, {
      read: id => this.readSnapshot(id),
      propose: (value, revision, askRef) => this.propose(value, revision, askRef),
      review: (id, agent, signal) => this.review(id, agent, signal),
      invoke: (id, revision, action, input, requestId) => this.invokeAction(id, revision, action, input, requestId, false),
      refresh: (id, revision, requestId) => this.refreshChecks(id, revision, requestId),
      readRun: id => this.persistedRun(id),
      remove: (id, revision, agent, signal) => this.reviewRemoval(id, revision, agent, signal),
    }, this.config.reviewTimeoutMs)
  }

  /** Read a shared machine view without running application checks.
   * @param machineId - canonical machine identity.
   * @returns the complete current application snapshot.
   */
  async read(machineId: MachineId): Promise<CardSnapshot> {
    return remoteCall(() => this.readSnapshot(machineId))
  }

  private async readSnapshot(machineId: MachineId): Promise<CardSnapshot> {
    this.assertLive()
    machineId = validatedMachineId(machineId)
    this.runs.assertMachineReadable(machineId)
    const current = await this.store.current(machineId)
    const checks = this.store.checks(machineId)
    const actions: Record<string, { enabled: boolean; reason?: string }> = {}
    if (current !== null) {
      validateUi(current.declaration)
      for (const [id, action] of Object.entries(current.declaration.actions)) {
        if (action.availability.kind === 'always') { actions[id] = { enabled: true }; continue }
        const check = checks[action.availability.checkId]
        if (check === undefined || check.stale || check.error !== undefined) {
          actions[id] = { enabled: false, reason: '请刷新所需检查，取得当前证据。' }
          continue
        }
        const result = await evaluateExpression(action.availability.source, asJson(check), this.expressionOptions())
        if (typeof result !== 'boolean') throw new AppCardError('AVAILABILITY_RESULT', 'Action availability must evaluate to a boolean')
        actions[id] = result ? { enabled: true } : { enabled: false, reason: '当前检查结果不满足此操作的条件。' }
      }
    }
    for(const run of this.store.activeActions(machineId)) if(run.revision===current?.declaration.revision) actions[run.entryId]={enabled:false,reason:'该操作正在执行'}
    const snapshot: CardSnapshot = {
      extensionGeneration:this.extensions.descriptor().generation,
      machineId, ...this.store.head(machineId), declaration: current?.declaration ?? null,
      checks, actions, runs: this.store.runs(machineId),
      drafts: await this.store.drafts(machineId),
    }
    this.bound(snapshot)
    return snapshot
  }

  /** Prepare a model-authored candidate without executing or authorizing it.
   * @param value - candidate declaration JSON.
   * @param expectedRevision - current shared version.
   * @param askRef - originating user need.
   * @returns inert proposal identifiers and exact execution digest.
   */
  private async propose(value: unknown, expectedRevision: number, askRef: string): Promise<CardProposal> {
    this.assertLive()
    this.bound(value)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || askRef.trim() === '') {
      throw new AppCardError('INVALID_PROPOSAL', 'Proposal requires a nonnegative revision and the originating user ask')
    }
    const declaration = parseDeclaration(value)
    if (declaration.revision !== expectedRevision + 1) throw new AppCardError('REVISION_CONFLICT', 'Candidate revision must be expectedRevision + 1')
    if (this.store.head(declaration.machineId).revision !== expectedRevision) throw new AppCardError('REVISION_CONFLICT', 'The machine declaration changed')
    validateUi(declaration)
    const contexts = await resolveContexts(declaration, this.ctx.machineMgmt, this.config.hostRoots, this.config.maxJsonBytes)
    const proposal: CardProposal = {
      id: randomUUID() as ProposalId, declaration, expectedRevision, contexts, askRef,
      executionDigest: executionDigest(declaration, contexts),
      documentDigest: digest(declaration), createdAt: Date.now(),
    }
    await this.store.propose(proposal)
    this.notify(declaration.machineId, 'declaration')
    return proposal
  }

  /** Render an inert draft with all actions disabled. Never runs its probes. */
  async preview(proposalId: string): Promise<CardSnapshot> {
    return remoteCall(async () => {
      const proposal=await this.store.proposal(validatedUuid(proposalId) as ProposalId)
      validateUi(proposal.declaration)
      return {extensionGeneration:this.extensions.descriptor().generation,machineId:proposal.declaration.machineId,revision:proposal.declaration.revision,sequence:0,
        declaration:proposal.declaration,checks:{},runs:[],
        actions:Object.fromEntries(Object.keys(proposal.declaration.actions).map(id=>[id,{enabled:false,reason:'草稿预览不执行操作'}]))}
    })
  }

  /** Await the exact human answer, then atomically publish that frozen proposal. */
  private async review(id: ProposalId, agent: Agent, signal: AbortSignal): Promise<{ revision: number }> {
    this.assertLive()
    const proposal = await this.store.proposal(validatedUuid(id) as ProposalId)
    const prior = await this.store.current(proposal.declaration.machineId)
    const reused = this.store.reusableEvidence(proposal.declaration.machineId, proposal.executionDigest)
    if (reused !== undefined) {
      await this.serial(proposal.declaration.machineId, async () => {
        const contexts = await resolveContexts(proposal.declaration, this.ctx.machineMgmt, this.config.hostRoots, this.config.maxJsonBytes)
        if (executionDigest(proposal.declaration, contexts) !== proposal.executionDigest) throw new AppCardError('CONTEXT_CHANGED', 'Execution identity changed before publication')
        signal.throwIfAborted()
        await this.store.publish(proposal, reused)
        this.notify(proposal.declaration.machineId, 'declaration')
      })
      return { revision: proposal.declaration.revision }
    }
    const review = buildReview(proposal, prior?.declaration ?? null)
    this.bound(review)
    const questionId = `app-cards:${proposal.id}`
    const approve = '认可并发布'
    const answer = await this.ctx.userQuestions.ask({
      agent, signal,
      questions: [{
        id: questionId, question: '是否认可这份执行清单并发布应用卡片？', header: '发布执行清单',
        detail: review.detail, multiSelect: false,
        options: [{ label: approve }, { label: '不发布' }],
      }],
    })
    signal.throwIfAborted()
    if (answer.answers.length !== 1 || answer.answers[0]?.id !== questionId
      || answer.answers[0].selected.length !== 1 || answer.answers[0].selected[0] !== approve
      || answer.answers[0].custom !== undefined) {
      throw new AppCardError('REVIEW_DECLINED', 'The execution declaration was not approved')
    }
    await this.serial(proposal.declaration.machineId, async () => {
      const frozen = await this.store.proposal(proposal.id)
      const contexts = await resolveContexts(frozen.declaration, this.ctx.machineMgmt, this.config.hostRoots, this.config.maxJsonBytes)
      if (executionDigest(frozen.declaration, contexts) !== frozen.executionDigest) {
        throw new AppCardError('CONTEXT_CHANGED', 'The execution context changed during review; prepare a new proposal')
      }
      signal.throwIfAborted()
      await this.store.publish(frozen, {
        questionId, sessionId: agent.id, selected: approve, approvedAt: Date.now(),
      })
      this.runs.cancelMachine(frozen.declaration.machineId)
      this.notify(frozen.declaration.machineId, 'declaration')
    })
    return { revision: proposal.declaration.revision }
  }

  /** Submit a declared action without another approval question.
   * @param machineId - owning machine.
   * @param revision - displayed declaration version.
   * @param actionId - declared action.
   * @param input - user parameters, not executable source.
   * @param requestId - durable retry identity.
   * @returns the precommitted execution receipt.
   */
  async invoke(machineId: MachineId, revision: number, actionId: string, input: JsonValue, requestId: string): Promise<RunRecord> {
    return remoteCall(() => this.invokeAction(machineId, revision, actionId, input, requestId, true))
  }

  private async invokeAction(
    machineId: MachineId, revision: number, actionId: string,
    input: JsonValue, requestId: string, clientDriven: boolean,
  ): Promise<RunRecord> {
    return this.serial(validatedMachineId(machineId), async () => {
      this.assertLive()
      this.bound(input)
      const request = {
        machineId, revision, requestId: validatedUuid(requestId) as RequestId,
        kind: 'action' as const, entryId: actionId, input,
      }
      const duplicate = this.store.findRequest(request)
      if (duplicate !== undefined) return duplicate
      const current = await this.requireCurrent(machineId, revision)
      const action = Object.hasOwn(current.declaration.actions, actionId) ? current.declaration.actions[actionId] : undefined
      if (action === undefined) throw new AppCardError('ACTION_MISSING', `Unknown action ${actionId}`)
      const operation = Object.hasOwn(current.declaration.operations, action.operation)
        ? current.declaration.operations[action.operation] : undefined
      if (operation === undefined) throw new AppCardError('OPERATION_MISSING', 'Action operation is missing')
      const resolvedInput = resolveBinding(action.input, { input, data: current.declaration.data })
      const errors = validateJsonSchemaValue(operation.inputSchema, resolvedInput)
      if (errors.length > 0) throw new AppCardError('INPUT_INVALID', errors.join('; '))
      const state = await this.readSnapshot(machineId)
      if (state.actions[actionId]?.enabled !== true) throw new AppCardError('ACTION_UNAVAILABLE', state.actions[actionId]?.reason ?? 'Action unavailable')
      this.runs.assertCapacity()
      const admitted = this.store.admit({ ...request, input: resolvedInput }, request)
      if (admitted.fresh) {
        this.store.invalidate(machineId, action.invalidates)
        this.runs.launch(admitted.run, current, action.operation, true, clientDriven)
        // One read-only reconciliation after settlement, including failures. No retry of the action.
        if(action.invalidates.length) void this.runs.task(admitted.run.id)?.then(async()=>{
          if(this.closed || this.store.head(machineId).revision!==revision) return
          await this.refreshChecks(machineId,revision,randomUUID(),action.invalidates)
        }).catch(error=>this.ctx.logger.warn('app-cards post-action observation failed: %s',String(error)))
      }
      return admitted.run
    })
  }

  /** Inspect this machine's applications once; no timer or event starts another inspection.
   * @param machineId - selected machine.
   * @param revision - current declaration version.
   * @param requestId - refresh gesture identity.
   * @returns one receipt for each declared check.
   */
  async refresh(machineId: MachineId, revision: number, requestId: string): Promise<RunRecord[]> {
    return remoteCall(() => this.refreshChecks(machineId, revision, requestId))
  }

  private async refreshChecks(machineId: MachineId, revision: number, requestId: string, only?: readonly string[]): Promise<RunRecord[]> {
    requestId = validatedUuid(requestId)
    const current = await this.requireCurrent(validatedMachineId(machineId), revision)
    const receipts: RunRecord[] = []
    for (const [id, check] of Object.entries(current.declaration.checks)) {
      if(only && !only.includes(id)) continue
      const key = `${machineId}/${revision}/${id}`
      const pending = this.checking.get(key)
      if (pending !== undefined) { receipts.push(await pending); continue }
      const admission = this.serial(machineId, async () => {
        await this.requireCurrent(machineId, revision)
        const input = resolveBinding(check.input, { input: {}, data: current.declaration.data })
        const request = {
          machineId, revision, kind: 'check', entryId: id, input,
          requestId: deterministicRequestId(requestId, id),
        } as const
        const duplicate = this.store.findRequest(request)
        if (duplicate !== undefined) return duplicate
        this.runs.assertCapacity()
        const admitted = this.store.admit(request)
        if (admitted.fresh) this.runs.launch(admitted.run, current, check.operation, false)
        return admitted.run
      })
      this.checking.set(key, admission)
      try {
        const receipt = await admission
        receipts.push(receipt)
        const task = this.runs.task(receipt.id)
        if (task !== undefined) void task.then(() => { this.checking.delete(key) })
        else this.checking.delete(key)
      } catch (error) { this.checking.delete(key); throw error }
    }
    return receipts
  }

  /** Read an existing invocation.
   * @param runId - recorded run identity.
   * @returns authoritative execution state.
   */
  readRun(runId: string): RunRecord {
    return remoteValue(() => this.persistedRun(runId))
  }

  private persistedRun(runId: string): RunRecord {
    this.assertLive()
    const id = validatedUuid(runId) as RunId
    return this.runs.read(id)
  }

  /** Request cancellation without claiming remote side effects were rolled back.
   * @param runId - recorded run identity.
   * @returns the current receipt.
   */
  cancel(runId: string): RunRecord {
    return remoteValue(() => {
      const run = this.persistedRun(runId)
      this.runs.cancel(run.id)
      return run
    })
  }

  /** Stream committed application changes through the trusted Remote carrier.
   * @param signal - stream cancellation owned by the Remote carrier.
   * @returns reset followed by every change committed for the plugin lifetime.
   */
  subscribe(signal: AbortSignal): AsyncIterable<AppCardNotificationFrame> {
    return remoteStream(() => {
      this.assertLive()
      signal.throwIfAborted()
      if (this.notifications === undefined) throw new AppCardError('NOTIFICATIONS_UNAVAILABLE', 'Application notifications are not mounted')
      return this.notifications.subscribe(signal)
    })
  }

  private async reviewRemoval(machineId: MachineId, revision: number, agent: Agent, signal: AbortSignal): Promise<void> {
    await this.requireCurrent(machineId, revision)
    const id = `app-cards-remove:${randomUUID()}`
    const answer = await this.ctx.userQuestions.ask({
      agent, signal, questions: [{
        id, question: `移除 ${machineId} 的应用卡片？这不会卸载应用或停止服务。`,
        options: [{ label: '移除卡片' }, { label: '保留' }],
      }],
    })
    signal.throwIfAborted()
    const response = answer.answers[0]
    if (answer.answers.length !== 1 || response?.id !== id || response.selected.length !== 1
      || response.selected[0] !== '移除卡片' || response.custom !== undefined) {
      throw new AppCardError('REVIEW_DECLINED', 'Card removal was not approved')
    }
    await this.serial(machineId, () => {
      this.store.remove(machineId, revision)
      this.runs.cancelMachine(machineId)
      this.notify(machineId, 'deleted')
      return Promise.resolve()
    })
  }

  private async requireCurrent(machineId: MachineId, revision: number): Promise<NonNullable<Awaited<ReturnType<AppCardStore['current']>>>> {
    this.assertLive()
    const current = await this.store.current(machineId)
    if (current === null) throw new AppCardError('DECLARATION_MISSING', 'No published application declaration for this machine')
    if (current.declaration.revision !== revision || this.store.head(machineId).revision !== revision) {
      throw new AppCardError('REVISION_CONFLICT', 'The displayed declaration is stale; reload it before invoking an action')
    }
    validateUi(current.declaration)
    return current
  }
  private expressionOptions() {
    return { timeoutMs: this.config.executionTimeoutMs, outputLimitBytes: this.config.outputLimitBytes }
  }
  private notify(machineId: MachineId, kind: 'declaration' | 'observation' | 'run' | 'deleted'): void {
    this.ctx.emit('app-cards/changed', { machineId, ...this.store.head(machineId), kind })
  }
  private bound(value: unknown): void {
    const content = canonicalJson(value)
    if (Buffer.byteLength(content) > this.config.maxJsonBytes) throw new AppCardError('JSON_LIMIT', 'Application payload exceeds maxJsonBytes')
  }
  private assertLive(): void {
    if (this.closed) throw new AppCardError('DISPOSED', 'Application service is disposed')
  }
  private async serial<T>(machineId: MachineId, operation: () => Promise<T>): Promise<T> {
    const prior = this.admissions.get(machineId) ?? Promise.resolve()
    const result = prior.then(operation)
    const tail = result.then(() => {}, () => {})
    this.admissions.set(machineId, tail)
    try { return await result } finally { if (this.admissions.get(machineId) === tail) this.admissions.delete(machineId) }
  }
}

function validatedMachineId(value: string): MachineId {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) throw new AppCardError('MACHINE_ID', 'Invalid machine id')
  return value as MachineId
}
function validatedUuid(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new AppCardError('REQUEST_ID', 'Invalid UUID')
  return value.toLowerCase()
}
function deterministicRequestId(requestId: string, checkId: string): RequestId {
  const hex = digest([requestId, checkId])
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as RequestId
}
function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export default AppCardsService
