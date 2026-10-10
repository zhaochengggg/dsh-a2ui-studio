/** Machine-scoped declarations and application execution records. @module @deepseek-ai/dsh-app-cards/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ObjectJsonSchema, JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { MachineId } from '../../machines/contracts.ts'

export type { JsonValue, MachineId }
/** Identity of an immutable proposal. */
export type ProposalId = Branded<'AppCardProposalId'>
/** Identity shared by an invocation and its persisted receipt. */
export type RunId = Branded<'AppCardRunId'>
/** Client-generated idempotency key, validated at admission. */
export type RequestId = Branded<'AppCardRequestId'>
/** Stable identity of one declaration entry. */
export type EntryId = Branded<'AppCardEntryId'>

/** Plugin-owned review data; it is not a question-protocol extension or an authorization flag. */
export interface ExecutionReviewDocument {
  readonly reviewId: string
  readonly executionDigest: string
  readonly machine: { readonly id: string; readonly name: string }
  readonly fromRevision: number
  readonly toRevision: number
  readonly contexts: readonly {
    readonly id: string
    readonly label: string
    readonly kind: 'host' | 'ssh'
    readonly cwd: string
  }[]
  readonly sections: readonly {
    readonly id: string
    readonly title: string
    readonly summary: string
    readonly body: string
    readonly changed: boolean
    readonly trigger: string
    readonly effect: string
  }[]
  readonly documentation?: string | undefined
}

/** Committed application invalidation; receiving it never starts a check. */
export interface AppCardChange {
  readonly machineId: MachineId
  readonly revision: number
  readonly sequence: number
  readonly kind: 'declaration' | 'observation' | 'run' | 'deleted'
}

/** One frame of the application notification stream; the opening frame only drops Client dedup state. */
export type AppCardNotificationFrame =
  | { readonly frame: 'reset' }
  | { readonly frame: 'changed'; readonly change: AppCardChange }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** An application rule refused the request; the code matches the plugin's local error. */
    'app-cards/rejected': { readonly code: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An application resource committed a change; only the application plugin forwards this event.
     * @param change - machine identity and committed revision.
     * @mode emit
     */
    'app-cards/changed'(change: AppCardChange): void
  }
}

/** Values are bound structurally; they never become executable source. */
export type Binding =
  | { readonly literal: JsonValue }
  | { readonly ref: string }
  | { readonly object: Readonly<Record<string, Binding>> }
  | { readonly array: readonly Binding[] }

/** Reviewed execution context; SSH identity is supplied by machine-mgmt. */
export type ExecutionContext =
  | { readonly kind: 'host'; readonly cwd: string }
  | { readonly kind: 'ssh'; readonly pathId: string; readonly cwd: string }

/** Concrete executable or complete script, never populated from runtime input. */
export type Program =
  | { readonly kind: 'argv'; readonly executable: string; readonly args: readonly Binding[] }
  | { readonly kind: 'script'; readonly interpreter: string; readonly source: string; readonly args: readonly Binding[] }

/** Fields common to the four operation primitives. */
export interface OperationBase {
  readonly inputSchema: ObjectJsonSchema
  readonly timeoutMs: number
}

/** A fully declared process invocation. */
export interface ExecOperation extends OperationBase {
  readonly kind: 'exec'
  readonly effect: 'observe' | 'change'
  readonly context: string
  readonly program: Program
  readonly stdin?: { readonly encoding: 'text' | 'json'; readonly value: Binding } | undefined
  readonly env?: Readonly<Record<string, Binding>> | undefined
  readonly output: { readonly decode: 'text' | 'json'; readonly schema: JsonSchemaNode }
  readonly successExitCodes: readonly number[]
  readonly outputLimitBytes: number
}

/** Bounded pure JSONata expression. */
export interface TransformOperation extends OperationBase {
  readonly kind: 'transform'
  readonly source: string
  readonly input: Binding
  readonly outputSchema: JsonSchemaNode
}

/** An agent receives only explicitly allowed declared operations. */
export interface AgentOperation extends OperationBase {
  readonly kind: 'agent'
  readonly prompt: string
  readonly input: Binding
  readonly completion: 'submitted' | 'result'
  readonly allowedOperations: readonly string[]
  readonly outputSchema: JsonSchemaNode
}

/** One node of a finite operation graph. */
export interface FlowStep {
  readonly id: string
  readonly operation: string
  readonly after: readonly string[]
  readonly runAfter: 'success' | 'settled'
  readonly input: Binding
  readonly when?: Binding | undefined
  readonly onError: 'stop' | 'continue'
}

/** Acyclic composition with bounded parallelism and explicit result bindings. */
export interface FlowOperation extends OperationBase {
  readonly kind: 'flow'
  readonly steps: readonly FlowStep[]
  readonly output: Binding
  readonly outputSchema: JsonSchemaNode
  readonly concurrency: number
}

/** The complete execution primitive set. */
export type Operation = ExecOperation | TransformOperation | AgentOperation | FlowOperation

/** Availability is either unconditional or based on a fresh check. */
export type ActionAvailability =
  | { readonly kind: 'always' }
  | { readonly kind: 'check'; readonly checkId: string; readonly source: string }

/** Named user entry point, independent of its component layout. */
export interface CardAction {
  readonly appId: string
  readonly label: string
  readonly operation: string
  readonly input: Binding
  readonly availability: ActionAvailability
  readonly invalidates: readonly string[]
}

/** An observation entry point, invoked only on open or explicit refresh. */
export interface CardCheck {
  readonly appId: string
  readonly label: string
  readonly operation: string
  readonly input: Binding
  readonly evaluate: { readonly language: 'jsonata'; readonly source: string }
  readonly freshForMs: number
}

/** A2UI component fields are validated against the registered catalog. */
export interface CardComponent {
  readonly id: string
  readonly component: string
  readonly [key: string]: JsonValue
}

/** Complete surface snapshot; runtime receipts are not declaration data. */
export interface CardSurface {
  readonly id: string
  readonly appId: string
  readonly order: number
  readonly formInitial: Readonly<Record<string, JsonValue>>
  readonly components: readonly CardComponent[]
}

/** Versioned document stored outside the machine infrastructure catalog. */
export interface CardDeclaration {
  readonly monitoring?: { readonly intervalMs: number }
  readonly apiVersion: 'dsh.app-cards/v1'
  readonly kind: 'MachineAppCards'
  readonly machineId: MachineId
  readonly revision: number
  readonly apps: Readonly<Record<string, { readonly name: string; readonly description?: string | undefined }>>
  readonly contexts: Readonly<Record<string, ExecutionContext>>
  readonly data: Readonly<Record<string, JsonValue>>
  readonly operations: Readonly<Record<string, Operation>>
  readonly actions: Readonly<Record<string, CardAction>>
  readonly checks: Readonly<Record<string, CardCheck>>
  readonly ui: {
    readonly a2uiVersion: '0.9.1'
    readonly catalogId: 'urn:dsh:app-cards:catalog:1'
    readonly previewScenarios?: readonly import('./preview.ts').PreviewScenario[]
    readonly surfaces: readonly CardSurface[]
  }
}

/** Reviewed access facts, compared again immediately before execution. */
export interface ResolvedContext {
  readonly kind: 'host' | 'ssh'
  readonly cwd: string
  readonly argvPrefix: readonly string[]
  readonly identity: string
  readonly display: string
}

/** Orthogonal process outcomes are preserved even on timeout or cancellation. */
export interface ProcessFacts {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly truncated: boolean
  readonly stderr: string
}

/** Terminal state of an individual primitive. */
export interface OperationResult {
  readonly state: 'succeeded' | 'failed' | 'partial' | 'cancelled' | 'indeterminate' | 'submitted' | 'skipped'
  readonly value: JsonValue
  readonly error?: { readonly code: string; readonly message: string } | undefined
  readonly process?: ProcessFacts | undefined
  readonly steps?: Readonly<Record<string, OperationResult>> | undefined
}

/** Evidence never doubles as a successful action receipt. */
export interface CheckObservation {
  readonly checkId: string
  readonly revision: number
  readonly runId: RunId
  readonly observedAt: number
  readonly expiresAt: number
  readonly health: 'healthy' | 'unhealthy' | 'unknown'
  readonly summary: string
  readonly value: JsonValue
  readonly stale: boolean
  readonly error?: string | undefined
}

/** Durable invocation, including uncertain outcomes after a Host restart. */
export interface RunRecord {
  readonly id: RunId
  readonly machineId: MachineId
  readonly revision: number
  readonly requestId: RequestId
  readonly kind: 'action' | 'check'
  readonly entryId: string
  readonly input: JsonValue
  readonly createdAt: number
  readonly finishedAt?: number | undefined
  readonly state: 'queued' | 'running' | OperationResult['state']
  readonly result?: OperationResult | undefined
  readonly submission?: { readonly sessionId: string; readonly text: string } | undefined
}

/** A candidate is inert until the Host receives its exact human review answer. */
export interface CardProposal {
  readonly id: ProposalId
  readonly declaration: CardDeclaration
  readonly expectedRevision: number
  readonly executionDigest: string
  readonly documentDigest: string
  readonly contexts: Readonly<Record<string, ResolvedContext>>
  readonly askRef: string
  readonly createdAt: number
}

/** Current authoritative machine view returned through Remote. */
export interface CardSnapshot {
  readonly extensionGeneration?: string
  readonly drafts?: readonly { id: string; revision: number; createdAt: number }[]
  readonly machineId: MachineId
  readonly revision: number
  readonly sequence: number
  readonly declaration: CardDeclaration | null
  readonly checks: Readonly<Record<string, CheckObservation>>
  readonly actions: Readonly<Record<string, { readonly enabled: boolean; readonly reason?: string }>>
  readonly runs: readonly RunRecord[]
}
