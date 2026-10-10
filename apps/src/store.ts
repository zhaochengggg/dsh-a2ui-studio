/** Immutable JSON revisions and transactional application receipts. @module @deepseek-ai/dsh-app-cards/store */

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, open, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod/v3'
import { parseDeclaration } from './declaration.ts'
import { digest, canonicalJson, executionDigest } from './digest.ts'
import { AppCardError } from './errors.ts'
import type {
  CardDeclaration, CardProposal, CheckObservation, JsonValue, MachineId,
  OperationResult, ProposalId, RequestId, ResolvedContext, RunId, RunRecord,
} from './types.ts'

/** Deployment-owned storage bounds. */
export interface StoreOptions {
  readonly dataPath: string
  readonly maxJsonBytes: number
  readonly historyLimit: number
  readonly busyTimeoutMs: number
}

/** A response captured from the Host-owned question lifecycle, never from model JSON. */
export interface ReviewEvidence {
  readonly questionId: string
  readonly sessionId: string
  readonly selected: string
  readonly approvedAt: number
}

const contextSchema = z.object({
  kind: z.enum(['host', 'ssh']), cwd: z.string(), argvPrefix: z.array(z.string()),
  identity: z.string(), display: z.string(),
}).strict()
const contextsSchema = z.record(contextSchema)
const errorSchema = z.object({ code: z.string(), message: z.string() }).strict()
const jsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(jsonSchema),
]))
const resultSchema: z.ZodType<OperationResult> = z.lazy(() => z.object({
  state: z.enum(['succeeded', 'failed', 'partial', 'cancelled', 'indeterminate', 'submitted', 'skipped']),
  value: jsonSchema,
  error: errorSchema.optional(),
  process: z.object({
    exitCode: z.number().nullable(), signal: z.string().nullable(),
    timedOut: z.boolean(), aborted: z.boolean(), truncated: z.boolean(), stderr: z.string(),
  }).strict().optional(),
  steps: z.record(resultSchema).optional(),
}).strict())
const runSchema = z.object({
  id: z.string(), machineId: z.string(), revision: z.number().int().nonnegative(),
  requestId: z.string(), kind: z.enum(['action', 'check']), entryId: z.string(),
  input: jsonSchema, createdAt: z.number(), finishedAt: z.number().optional(),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'partial', 'cancelled', 'indeterminate', 'submitted', 'skipped']),
  result: resultSchema.optional(),
  submission: z.object({ sessionId: z.string(), text: z.string() }).strict().optional(),
}).strict()
const observationSchema = z.object({
  checkId: z.string(), revision: z.number(), runId: z.string(), observedAt: z.number(),
  expiresAt: z.number(), health: z.enum(['healthy', 'unhealthy', 'unknown']),
  summary: z.string(), value: jsonSchema, stale: z.boolean(), error: z.string().optional(),
}).strict()

function text(row: Record<string, unknown>, field: string): string {
  return z.string().parse(row[field])
}
function integer(row: Record<string, unknown>, field: string): number {
  return z.number().int().nonnegative().parse(row[field])
}

/** One process owns this database; every external effect has a precommitted receipt. */
export class AppCardStore {
  private constructor(private readonly db: DatabaseSync, private readonly options: StoreOptions) {}

  /** Open a private application store and mark interrupted runs uncertain.
   * @param options - absolute private directory and configured bounds.
   * @returns the opened owner.
   */
  static async open(options: StoreOptions): Promise<AppCardStore> {
    await mkdir(options.dataPath, { recursive: true, mode: 0o700 })
    const directory = await lstat(options.dataPath)
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new AppCardError('UNSAFE_STORE', 'app-cards dataPath must be a directory, not a symlink')
    }
    if (process.platform !== 'win32' && (directory.mode & 0o077) !== 0) {
      throw new AppCardError('UNSAFE_STORE', 'app-cards dataPath must be owner-only (mode 0700)')
    }
    const resolvedOptions = { ...options, dataPath: await realpath(options.dataPath) }
    const path = join(resolvedOptions.dataPath, 'state.sqlite3')
    const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    await file.close()
    if ((await lstat(path)).isSymbolicLink()) throw new AppCardError('UNSAFE_STORE', 'app-cards database must not be a symlink')
    const db = new DatabaseSync(path)
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${options.busyTimeoutMs}`)
      const version = db.prepare('PRAGMA user_version').get()?.['user_version']
      if (version !== 0 && version !== 1) throw new AppCardError('STORE_VERSION', `Unsupported app-cards database version ${String(version)}`)
      db.exec(`
        CREATE TABLE IF NOT EXISTS machines (
          id TEXT PRIMARY KEY, revision INTEGER NOT NULL, sequence INTEGER NOT NULL,
          document_digest TEXT, execution_digest TEXT, contexts_json TEXT, deleted INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS proposals (
          id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, expected_revision INTEGER NOT NULL,
          digest TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE TABLE IF NOT EXISTS grants (
          proposal_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, execution_digest TEXT NOT NULL,
          document_digest TEXT NOT NULL, evidence_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, request_id TEXT NOT NULL,
          request_digest TEXT NOT NULL, record_json TEXT NOT NULL,
          UNIQUE(machine_id, request_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS checks (
          machine_id TEXT NOT NULL, check_id TEXT NOT NULL, record_json TEXT NOT NULL,
          PRIMARY KEY(machine_id, check_id)
        ) STRICT;
        PRAGMA user_version=1;
      `)
      const store = new AppCardStore(db, resolvedOptions)
      for (const row of db.prepare('SELECT record_json FROM runs').all()) {
        const run = store.parseRun(text(row, 'record_json'))
        if (run.state === 'queued' || run.state === 'running') {
          store.finish(run.id, {
            state: 'indeterminate', value: null,
            error: { code: 'HOST_RESTARTED', message: 'Host restarted before the operation result was recorded; do not replay automatically.' },
          })
        }
      }
      return store
    } catch (error) {
      db.close()
      throw error
    }
  }

  /** Release the owned connection after execution quiescence. */
  close(): void { this.db.close() }

  /** Latest inert drafts, never execution grants. */
  async drafts(machineId: MachineId): Promise<{id:string;revision:number;createdAt:number}[]> {
    const rows=this.db.prepare('SELECT id FROM proposals WHERE machine_id=? AND consumed=0 ORDER BY rowid DESC LIMIT 5').all(machineId)
    const result=[]
    for(const row of rows){
      const proposal=await this.proposal(text(row,'id') as ProposalId)
      if(proposal.expectedRevision===this.head(machineId).revision) result.push({id:proposal.id,revision:proposal.declaration.revision,createdAt:proposal.createdAt})
    }
    return result
  }

  /** Read the current version even for a deleted declaration.
   * @param machineId - validated machine identity.
   * @returns monotonic revision and notification sequence.
   */
  head(machineId: MachineId): { revision: number; sequence: number } {
    const row = this.db.prepare('SELECT revision, sequence FROM machines WHERE id=?').get(machineId)
    return row === undefined ? { revision: 0, sequence: 0 } : {
      revision: integer(row, 'revision'), sequence: integer(row, 'sequence'),
    }
  }

  /** Read and verify the active immutable file and matching authorization.
   * @param machineId - validated machine identity.
   * @returns declaration and authorized contexts, or null if not published.
   */
  async current(machineId: MachineId): Promise<{
    declaration: CardDeclaration
    contexts: Readonly<Record<string, ResolvedContext>>
    executionDigest: string
  } | null> {
    const row = this.db.prepare('SELECT * FROM machines WHERE id=?').get(machineId)
    if (row === undefined || row['deleted'] === 1) return null
    const revision = integer(row, 'revision')
    const document = parseDeclaration(await this.readJson(this.revisionPath(machineId, revision, text(row, 'document_digest'))))
    if (document.machineId !== machineId || document.revision !== revision || digest(document) !== text(row, 'document_digest')) {
      throw new AppCardError('INTEGRITY', 'The published application declaration was modified outside publication')
    }
    const authorized = this.db.prepare('SELECT proposal_id FROM grants WHERE machine_id=? AND document_digest=? AND execution_digest=?')
      .get(machineId, text(row, 'document_digest'), text(row, 'execution_digest'))
    if (authorized === undefined) throw new AppCardError('UNAUTHORIZED', 'The active declaration has no matching human authorization')
    if (this.head(machineId).revision !== revision) throw new AppCardError('REVISION_CONFLICT', 'The declaration changed during the read')
    const contexts = contextsSchema.parse(JSON.parse(text(row, 'contexts_json')))
    if (executionDigest(document, contexts) !== text(row, 'execution_digest')) {
      throw new AppCardError('INTEGRITY', 'The stored executable declaration does not match its authorization digest')
    }
    return {
      declaration: document,
      contexts,
      executionDigest: text(row, 'execution_digest'),
    }
  }

  /** Reuse an active authorization only for an unchanged executable definition.
   * @param machineId - current target.
   * @param expectedDigest - exact candidate execution digest.
   * @returns original human evidence, or undefined when a new review is required.
   */
  reusableEvidence(machineId: MachineId, expectedDigest: string): ReviewEvidence | undefined {
    const row = this.db.prepare(`SELECT grants.evidence_json FROM machines JOIN grants
      ON machines.id=grants.machine_id AND machines.document_digest=grants.document_digest
      WHERE machines.id=? AND machines.deleted=0 AND machines.execution_digest=?`).get(machineId, expectedDigest)
    if (row === undefined) return undefined
    return z.object({
      questionId: z.string(), sessionId: z.string(), selected: z.string(), approvedAt: z.number(),
    }).strict().parse(JSON.parse(text(row, 'evidence_json')))
  }

  /** Persist an inert immutable candidate.
   * @param proposal - validated candidate and execution snapshot.
   */
  async propose(proposal: CardProposal): Promise<void> {
    await this.writeJson(join(this.options.dataPath, 'proposals', `${proposal.id}.json`), proposal)
    this.db.prepare('INSERT INTO proposals(id,machine_id,expected_revision,digest) VALUES(?,?,?,?)')
      .run(proposal.id, proposal.declaration.machineId, proposal.expectedRevision, digest(proposal))
  }

  /** Verify and retrieve a pending candidate.
   * @param id - Host-issued proposal identity.
   * @returns the unmodified candidate.
   */
  async proposal(id: ProposalId): Promise<CardProposal> {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id=? AND consumed=0').get(id)
    if (row === undefined) throw new AppCardError('PROPOSAL_MISSING', 'The proposal is missing or has already been answered')
    const value = await this.readJson(join(this.options.dataPath, 'proposals', `${id}.json`))
    if (digest(value) !== text(row, 'digest')) throw new AppCardError('INTEGRITY', 'The pending proposal was modified')
    const parsed = z.object({
      id: z.string(), declaration: z.unknown(), expectedRevision: z.number().int().nonnegative(),
      executionDigest: z.string(), documentDigest: z.string(),
      contexts: contextsSchema, askRef: z.string(), createdAt: z.number(),
    }).strict().parse(value)
    return { ...parsed, id, declaration: parseDeclaration(parsed.declaration) }
  }

  /** Commit a previously answered proposal and its evidence in one transaction.
   * @param proposal - frozen reviewed candidate.
   * @param evidence - answer received by the trusted Host question owner.
   */
  async publish(proposal: CardProposal, evidence: ReviewEvidence): Promise<void> {
    const stored = await this.proposal(proposal.id)
    if (digest(stored) !== digest(proposal)) throw new AppCardError('INTEGRITY', 'Publication does not match the frozen review')
    const path = this.revisionPath(proposal.declaration.machineId, proposal.declaration.revision, proposal.documentDigest)
    await this.writeJson(path, proposal.declaration)
    this.transaction(() => {
      const head = this.head(proposal.declaration.machineId)
      if (head.revision !== proposal.expectedRevision) throw new AppCardError('REVISION_CONFLICT', 'The machine declaration changed during review')
      const consumed = this.db.prepare('UPDATE proposals SET consumed=1 WHERE id=? AND consumed=0').run(proposal.id)
      if (consumed.changes !== 1) throw new AppCardError('REVIEW_SETTLED', 'This review has already settled')
      this.db.prepare('INSERT INTO grants VALUES(?,?,?,?,?)').run(
        proposal.id, proposal.declaration.machineId, proposal.executionDigest,
        proposal.documentDigest, this.json(evidence),
      )
      this.db.prepare(`INSERT INTO machines VALUES(?,?,?,?,?,?,0)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,sequence=excluded.sequence,
        document_digest=excluded.document_digest,execution_digest=excluded.execution_digest,
        contexts_json=excluded.contexts_json,deleted=0`)
        .run(proposal.declaration.machineId, proposal.declaration.revision, head.sequence + 1,
          proposal.documentDigest, proposal.executionDigest, this.json(proposal.contexts))
      this.db.prepare('DELETE FROM checks WHERE machine_id=?').run(proposal.declaration.machineId)
    })
  }

  /** Withdraw a shared declaration without uninstalling an application.
   * @param machineId - affected identity.
   * @param revision - compare-and-swap baseline.
   */
  remove(machineId: MachineId, revision: number): void {
    this.transaction(() => {
      if (this.head(machineId).revision !== revision) throw new AppCardError('REVISION_CONFLICT', 'The declaration changed before removal')
      this.db.prepare('UPDATE machines SET deleted=1,revision=revision+1,sequence=sequence+1 WHERE id=?').run(machineId)
      this.db.prepare('DELETE FROM checks WHERE machine_id=?').run(machineId)
    })
  }

  /** Reserve a durable invocation before executing an external effect.
   * @param input - exact request fields.
   * @param request - original request identity before structural input binding.
   * @returns existing receipt for an identical retry, otherwise a new queued receipt.
   */
  admit(
    input: Pick<RunRecord, 'machineId' | 'revision' | 'requestId' | 'kind' | 'entryId' | 'input'>,
    request: Pick<RunRecord, 'machineId' | 'revision' | 'requestId' | 'kind' | 'entryId' | 'input'> = input,
  ): { run: RunRecord; fresh: boolean } {
    const duplicate = this.findRequest(request)
    if (duplicate !== undefined) return { run: duplicate, fresh: false }
    const requestDigest = digest(request)
    const run: RunRecord = { ...input, id: randomUUID() as RunId, createdAt: Date.now(), state: 'queued' }
    this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(run.id, run.machineId, run.requestId, requestDigest, this.json(run))
    this.bump(run.machineId)
    return { run, fresh: true }
  }

  /** Resolve an identical retry without re-evaluating current availability or starting work.
   * @param input - fully resolved original request.
   * @returns its receipt when already admitted.
   */
  findRequest(input: Pick<RunRecord, 'machineId' | 'revision' | 'requestId' | 'kind' | 'entryId' | 'input'>): RunRecord | undefined {
    const prior = this.db.prepare('SELECT request_digest,record_json FROM runs WHERE machine_id=? AND request_id=?')
      .get(input.machineId, input.requestId)
    if (prior !== undefined) {
      if (text(prior, 'request_digest') !== digest(input)) throw new AppCardError('REQUEST_CONFLICT', 'This request id was already used with different content')
      return this.parseRun(text(prior, 'record_json'))
    }
    return undefined
  }

  /** Read a recorded invocation.
   * @param id - run identity.
   * @returns authoritative receipt.
   */
  run(id: RunId): RunRecord {
    const row = this.db.prepare('SELECT record_json FROM runs WHERE id=?').get(id)
    if (row === undefined) throw new AppCardError('RUN_MISSING', 'Unknown application run')
    return this.parseRun(text(row, 'record_json'))
  }

  /** Mark a queued receipt running before spawn.
   * @param id - queued run.
   */
  start(id: RunId): void { this.saveRun({ ...this.run(id), state: 'running' }) }

  /** Publish a single reviewed prompt for browser session admission.
   * @param id - running agent operation.
   * @param submission - prepared session and exact prompt.
   */
  preparePrompt(id: RunId, submission: NonNullable<RunRecord['submission']>): void {
    this.saveRun({ ...this.run(id), submission })
  }

  /** Clear a prompt after its exact content was claimed by the scoped agent.
   * @param id - running agent operation.
   */
  claimPrompt(id: RunId): void {
    const { submission: _submission, ...run } = this.run(id)
    this.saveRun(run)
  }

  /** Persist terminal facts, never synthesizing healthy status.
   * @param id - run identity.
   * @param result - completed primitive result.
   * @returns terminal receipt.
   */
  finish(id: RunId, result: OperationResult): RunRecord {
    const { submission: _submission, ...prior } = this.run(id)
    const run = { ...prior, state: result.state, result, finishedAt: Date.now() }
    this.saveRun(run)
    return run
  }

  /** Latest bounded invocation list.
   * @param machineId - target machine.
   * @returns newest-first receipts.
   */
  runs(machineId: MachineId): readonly RunRecord[] {
    return this.db.prepare('SELECT record_json FROM runs WHERE machine_id=? ORDER BY rowid DESC LIMIT ?')
      .all(machineId, this.options.historyLimit).map(row => this.parseRun(text(row, 'record_json')))
  }

  activeActions(machineId: MachineId): readonly RunRecord[] {
    return this.db.prepare("SELECT record_json FROM runs WHERE machine_id=? AND json_extract(record_json,'$.kind')='action' AND json_extract(record_json,'$.state') IN ('queued','running')")
      .all(machineId).map(row=>this.parseRun(text(row,'record_json')))
  }

  /** Persist one check only while its declaration remains current.
   * @param machineId - target machine.
   * @param observation - completed observation.
   */
  observe(machineId: MachineId, observation: CheckObservation): void {
    if (this.head(machineId).revision !== observation.revision) return
    this.db.prepare('INSERT INTO checks VALUES(?,?,?) ON CONFLICT(machine_id,check_id) DO UPDATE SET record_json=excluded.record_json')
      .run(machineId, observation.checkId, this.json(observation))
    this.bump(machineId)
  }

  /** Read observations with current freshness.
   * @param machineId - target machine.
   * @returns check-keyed evidence.
   */
  checks(machineId: MachineId): Record<string, CheckObservation> {
    const entries = this.db.prepare('SELECT record_json FROM checks WHERE machine_id=?').all(machineId)
      .map((row) => {
        const parsed = observationSchema.parse(JSON.parse(text(row, 'record_json')))
        const value: CheckObservation = { ...parsed, runId: parsed.runId as RunId, stale: parsed.stale || Date.now() >= parsed.expiresAt }
        return [value.checkId, value] as const
      })
    return Object.fromEntries(entries)
  }

  /** Invalidate evidence at operation admission, without starting a new check.
   * @param machineId - target machine.
   * @param ids - affected checks.
   */
  invalidate(machineId: MachineId, ids: readonly string[]): void {
    const checks = this.checks(machineId)
    for (const id of ids) {
      const check = checks[id]
      if (check !== undefined) this.observe(machineId, { ...check, stale: true })
    }
  }

  private saveRun(run: RunRecord): void {
    this.db.prepare('UPDATE runs SET record_json=? WHERE id=?').run(this.json(run), run.id)
    this.bump(run.machineId)
  }
  private bump(machineId: MachineId): void {
    this.db.prepare('UPDATE machines SET sequence=sequence+1 WHERE id=?').run(machineId)
  }
  private parseRun(value: string): RunRecord {
    const parsed = runSchema.parse(JSON.parse(value))
    return { ...parsed, id: parsed.id as RunId, machineId: parsed.machineId as MachineId, requestId: parsed.requestId as RequestId }
  }
  private revisionPath(machineId: MachineId, revision: number, documentDigest: string): string {
    if (!/^[a-f0-9]{64}$/.test(documentDigest)) throw new AppCardError('INTEGRITY', 'Invalid stored declaration digest')
    return join(this.options.dataPath, 'machines', machineId, 'revisions', `${revision}-${documentDigest}.json`)
  }
  private json(value: unknown): string {
    const result = canonicalJson(value)
    if (Buffer.byteLength(result) > this.options.maxJsonBytes) throw new AppCardError('RECORD_LIMIT', 'Application JSON exceeds maxJsonBytes')
    return result
  }
  private async readJson(path: string): Promise<unknown> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > this.options.maxJsonBytes) {
      throw new AppCardError('INVALID_RECORD', `Invalid or oversized application record: ${path}`)
    }
    const content = await readFile(path, 'utf8')
    if (Buffer.byteLength(content) > this.options.maxJsonBytes) throw new AppCardError('RECORD_LIMIT', 'Application record exceeds maxJsonBytes')
    return JSON.parse(content) as unknown
  }
  private async writeJson(path: string, value: unknown): Promise<void> {
    const content = `${this.json(value)}\n`
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
    let file
    try {
      file = await open(path, 'wx', 0o600)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (canonicalJson(await this.readJson(path)) !== canonicalJson(value)) {
        throw new AppCardError('REVISION_CONFLICT', 'An immutable revision already exists with different content')
      }
      return
    }
    try { await file.writeFile(content); await file.sync() } finally { await file.close() }
  }
  private transaction(operation: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try { operation(); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
