/** Selected-machine app reads and explicit check admission, without polling. @module */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { CardSnapshot, JsonValue, MachineId, RunRecord } from '../types.ts'
import { validateUi } from '../ui-catalog.ts'

/** Generated asynchronous Remote methods consumed by application cards. */
export interface AppCardsRemotePort {
  read(machineId: MachineId): Promise<RemoteResult<CardSnapshot>>
  invoke(machineId: MachineId, revision: number, actionId: string, input: JsonValue, requestId: string): Promise<RemoteResult<RunRecord>>
  refresh(machineId: MachineId, revision: number, requestId: string): Promise<RemoteResult<readonly RunRecord[]>>
  readRun(runId: string): Promise<RemoteResult<RunRecord>>
  cancel(runId: string): Promise<RemoteResult<RunRecord>>
}

/** Slot-visible snapshot; failed reads never retain successful health indicators. */
export interface AppCardsView {
  readonly machineId: MachineId | null
  readonly data: CardSnapshot | null
  readonly pending: boolean
  readonly error: string | null
}

/** Read-only event notification; it never authorizes another check. */
export interface AppCardsChanged {
  readonly machineId: MachineId
  readonly revision: number
  readonly sequence: number
  readonly kind: 'declaration' | 'observation' | 'run' | 'deleted'
}

/** Own one mounted machine region and deduplicate open/manual-refresh check requests. */
export class AppCardsController {
  private snapshot: AppCardsView = { machineId: null, data: null, pending: false, error: null }
  private readonly listeners = new Set<() => void>()
  private key: string | undefined
  private generation = 0
  private readGeneration = 0
  private active = false
  private disposed = false
  private minimumSequence = 0
  private minimumRevision = 0
  private actionPending = false
  private readonly submissions = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private refreshing = false

  /**
   * @param remote - mounted app-cards Remote namespace.
   * @param reportError - repository-standard visible failure logger.
   */
  constructor(
    private readonly remote: AppCardsRemotePort,
    private readonly reportError: (error: unknown) => void,
    private readonly submitPrompt?: (sessionId: string, text: string) => Promise<void>,
  ) {}

  /** Read current application view state.
   * @returns identity-stable state for the injected selector hook.
   */
  getSnapshot = (): AppCardsView => this.snapshot

  /**
   * Observe application view changes.
   * @param listener - notified after publication.
   * @returns unsubscribe.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read and request checks once for this explicit open/refresh identity.
   * @param machineId - selected machine only.
   * @param openKey - incremented by the workbench owner for each opening.
   * @param refreshKey - incremented by the owner on manual refresh.
   * @returns release function; it does not cancel already admitted Host runs.
   */
  open = (machineId: MachineId, openKey: string | number, refreshKey: string | number): (() => void) => {
    if (this.disposed) throw new Error('App-cards controller is disposed')
    this.active = true
    const key = JSON.stringify([machineId, openKey, refreshKey])
    if (this.key !== key) {
      this.key = key
      this.minimumSequence = 0
      this.minimumRevision = 0
      this.actionPending = false
      const generation = ++this.generation
      this.publish({ machineId, data: null, pending: true, error: null })
      void this.checkOnOpen(generation)
    }
    const generation = this.generation
    this.schedule()
    return () => { if (generation === this.generation) {this.active = false; clearTimeout(this.timer)} }
  }

  /** Explicit refresh or declared visible-only monitoring; never overlaps admissions. */
  refresh = (): void => {
    if(!this.active || this.disposed || this.refreshing) return
    const data=this.snapshot.data
    if(!data?.declaration) return
    this.refreshing=true
    const generation=this.generation
    void this.remote.refresh(data.machineId,data.revision,randomUUID()).then(unwrap).then(()=>this.read(generation))
      .catch(error=>this.fail(error,generation)).finally(()=>{this.refreshing=false;this.schedule()})
  }

  private schedule(): void {
    clearTimeout(this.timer)
    const ms=this.snapshot.data?.declaration?.monitoring?.intervalMs
    if(!ms || !this.active || this.disposed) return
    this.timer=setTimeout(()=>{
      if(typeof document!=='undefined' && document.visibilityState==='hidden') this.schedule()
      else this.refresh()
    },ms)
  }

  /**
   * Invalidate obsolete evidence and reread only the mounted machine.
   * @param event - Host commit notification.
   */
  changed(event: AppCardsChanged): void {
    if (!this.active || event.machineId !== this.snapshot.machineId) return
    this.minimumSequence = Math.max(this.minimumSequence, event.sequence)
    this.minimumRevision = Math.max(this.minimumRevision, event.revision)
    this.reread()
  }

  /** Reread after a connection/reset notification without admitting checks. */
  reread(): void {
    if (!this.active || this.disposed) return
    const generation = this.generation
    void this.read(generation).catch((error: unknown) => { this.fail(error, generation) })
  }

  /** Show loss of the application channel without presenting stale health as current.
   * @param error - transport failure; a subsequent reset only rereads data.
   */
  notificationFailed(error: Error): void {
    this.fail(error, this.generation)
  }

  /**
   * Invoke a declared action with one idempotency key; double-clicks are ignored while pending.
   * @param actionId - declared entry identity.
   * @param input - resolved A2UI action context.
   */
  invoke = (actionId: string, input: JsonValue): void => {
    const data = this.snapshot.data
    if (!data || !this.active || this.snapshot.pending || this.actionPending
      || data.actions[actionId]?.enabled !== true) return
    this.actionPending = true
    const generation = this.generation
    this.publish({ ...this.snapshot, pending: true, error: null })
    void (async () => {
      try {
        unwrap(await this.remote.invoke(data.machineId, data.revision, actionId, input, randomUUID()))
        if (this.current(generation)) await this.read(generation)
      } catch (error: unknown) {
        this.fail(error, generation)
      } finally {
        if (generation === this.generation) this.actionPending = false
      }
    })()
  }

  /**
   * Cancel a run through its durable Host owner and reread the receipt.
   * @param runId - run identity displayed by the current machine.
   */
  cancel = (runId: string): void => {
    if (!this.active || this.actionPending) return
    const generation = this.generation
    this.actionPending = true
    this.publish({ ...this.snapshot, pending: true, error: null })
    void (async () => {
      try {
        unwrap(await this.remote.cancel(runId))
        if (this.current(generation)) await this.read(generation)
      } catch (error: unknown) {
        this.fail(error, generation)
      } finally {
        if (generation === this.generation) this.actionPending = false
      }
    })()
  }

  /** Release subscribers and reject late request completions. */
  dispose(): void {
    clearTimeout(this.timer)
    this.disposed = true
    this.active = false
    this.generation++
    this.readGeneration++
    this.listeners.clear()
  }

  private async checkOnOpen(generation: number): Promise<void> {
    try {
      const data = await this.read(generation)
      if (!data?.declaration || !this.current(generation)) return
      this.publish({ ...this.snapshot, pending: true })
      unwrap(await this.remote.refresh(data.machineId, data.revision, randomUUID()))
      if (this.current(generation)) await this.read(generation)
    } catch (error: unknown) {
      this.fail(error, generation)
    }
  }

  private async read(generation: number): Promise<CardSnapshot | null> {
    const machineId = this.snapshot.machineId
    if (machineId === null) return null
    const readGeneration = ++this.readGeneration
    this.publish({ ...this.snapshot, pending: this.snapshot.data===null || this.actionPending, error: null })
    const data = unwrap(await this.remote.read(machineId))
    // A notification may start a newer read while this response is in flight.
    // Ignore the superseded response before checking sequence, rather than clearing
    // the entire card tree (which would destroy unsaved form values).
    if (!this.current(generation) || readGeneration !== this.readGeneration) return null
    if (data.machineId !== machineId) throw new Error('App-card response belongs to another machine')
    if (data.revision < this.minimumRevision || data.sequence < this.minimumSequence) {
      throw new Error('App-card response is older than the latest Host notification')
    }
    if (data.declaration) {
      validateUi(data.declaration)
      if (data.declaration.revision !== data.revision) throw new Error('App-card declaration revision does not match the snapshot')
    }
    for (const run of data.runs) {
      if (run.submission === undefined || this.submissions.has(run.id)) continue
      if (this.submitPrompt === undefined) throw new Error('Application prompt submission is unavailable')
      this.submissions.add(run.id)
      try { await this.submitPrompt(run.submission.sessionId, run.submission.text) } catch (error) {
        this.submissions.delete(run.id)
        throw error
      }
    }
    if (readGeneration === this.readGeneration) {
      const previous = this.snapshot.data
      const declaration = previous?.revision === data.revision ? previous.declaration : data.declaration
      this.publish({ machineId, data: { ...data, declaration }, pending: false, error: null })
      this.schedule()
    }
    return data
  }

  private fail(error: unknown, generation: number): void {
    this.reportError(error)
    if (!this.current(generation)) return
    this.publish({ ...this.snapshot, data: null, pending: false, error: error instanceof Error ? error.message : String(error) })
  }

  private current(generation: number): boolean {
    return !this.disposed && this.active && generation === this.generation
  }

  private publish(snapshot: AppCardsView): void {
    if (this.disposed) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error(`${result.error.code}: ${result.error.message}`)
}
