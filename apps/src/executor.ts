/** Bounded primitive execution through the subprocess provider and finite dependency graphs. @module @deepseek-ai/dsh-app-cards/executor */

import { dirname } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod/v3'
import { detectRemote, remoteInvocation, remoteCompletion, scriptArgv } from '../../shared/remote-execution.mjs'
import { resolveBinding } from './declaration.ts'
import { AppCardError, errorMessage } from './errors.ts'
import { evaluateExpression } from './expression.ts'
import type {
  AgentOperation, Binding, CardDeclaration, ExecOperation, FlowOperation,
  JsonValue, OperationResult, ResolvedContext,
} from './types.ts'

/** Host-owned execution capabilities. Authorization and idempotency remain outside this engine. */
export interface ExecutionEnvironment {
  readonly subprocess: SubprocessRuntime
  readonly contexts: Readonly<Record<string, ResolvedContext>>
  readonly signal: AbortSignal
  readonly limits: {
    readonly timeoutMs: number
    readonly outputLimitBytes: number
    readonly graceMs: number
    readonly concurrency: number
  }
  /** Rejects if the current grant or revision no longer permits the next effect. */
  readonly beforeStep?: (() => Promise<void>) | undefined
  /** Must settle only after agent work and delegated operations have stopped on cancellation. */
  readonly runAgent: (operation: AgentOperation, input: JsonValue, signal: AbortSignal) => Promise<OperationResult>
}

interface Deadline {
  readonly signal: AbortSignal
  readonly timedOut: () => boolean
  readonly close: () => void
}

const json = z.custom<JsonValue>(isJsonValue, 'Process output is not lossless JSON')
const stdinValue = z.discriminatedUnion('encoding', [
  z.object({ encoding: z.literal('text'), value: z.string() }).strict(),
  z.object({ encoding: z.literal('json'), value: json }).strict(),
])

function deadline(parent: AbortSignal, milliseconds: number): Deadline {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort(new AppCardError('OPERATION_TIMEOUT', 'Operation exceeded timeoutMs'))
  }, milliseconds)
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    timedOut: () => expired || parent.reason instanceof AppCardError && parent.reason.code === 'OPERATION_TIMEOUT',
    close: () =>{  clearTimeout(timer) },
  }
}

function failure(error: unknown, state: OperationResult['state'] = 'failed'): OperationResult {
  return {
    state, value: null,
    error: { code: error instanceof AppCardError ? error.code : 'OPERATION_FAILED', message: errorMessage(error) },
  }
}

function succeeded(result: OperationResult): boolean {
  return result.state === 'succeeded'
}

function assertSchema(schema: JsonSchemaNode, value: JsonValue, subject: string): void {
  const violations = validateJsonSchemaValue(schema, value, subject)
  if (violations.length > 0) throw new AppCardError('SCHEMA_MISMATCH', violations.join('; '))
}

function stringValue(binding: Binding, input: JsonValue, declaration: CardDeclaration, subject: string): string {
  const value = resolveBinding(binding, { input, data: { ...declaration.data } })
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new AppCardError('BINDING_TYPE', `${subject} must resolve to a NUL-free string; implicit conversion is not supported`)
  }
  return value
}

function programArgv(operation: ExecOperation, input: JsonValue, declaration: CardDeclaration): string[] {
  const program = operation.program
  const args = program.args.map((value, index) => stringValue(value, input, declaration, `Argument ${index}`))
  if (program.kind === 'argv') return [program.executable, ...args]
  try { return scriptArgv(program.interpreter, program.source, args) }
  catch (error) { throw new AppCardError('INTERPRETER_UNSUPPORTED', errorMessage(error)) }
}

/** A shared leaf semaphore prevents nested flows from multiplying the Host concurrency limit. */
class Slots {
  private active = 0
  private readonly waiting = new Set<() => void>()

  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const ready = (): void => {
          signal.removeEventListener('abort', aborted)
          this.waiting.delete(ready)
          resolve()
        }
        const aborted = (): void => {
          this.waiting.delete(ready)
          reject(signal.reason instanceof Error ? signal.reason : new AppCardError('ABORTED', 'Operation was cancelled'))
        }
        this.waiting.add(ready)
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) aborted()
      })
    }
    signal.throwIfAborted()
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      this.waiting.values().next().value?.()
    }
  }
}

function bytePrefix(value: string, limit: number): string {
  let bytes = 0
  let result = ''
  for (const character of value) {
    bytes += Buffer.byteLength(character)
    if (bytes > limit) break
    result += character
  }
  return result
}

function boundResult(result: OperationResult, maxBytes: number): OperationResult {
  if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) return result
  const limited: OperationResult = {
    ...result, state: result.state === 'succeeded' ? 'failed' : result.state, value: null,
    error: { code: 'RESULT_OUTPUT_LIMIT', message: 'Complete operation result exceeds outputLimitBytes' },
    ...result.process === undefined ? {} : { process: { ...result.process, stderr: '', truncated: true } },
  }
  if (Buffer.byteLength(JSON.stringify(limited)) > maxBytes) {
    throw new AppCardError('RESULT_OUTPUT_LIMIT', 'outputLimitBytes cannot retain the operation outcome and step metadata')
  }
  return limited
}

async function executeProcess(
  operation: ExecOperation,
  input: JsonValue,
  declaration: CardDeclaration,
  env: ExecutionEnvironment,
  clock: Deadline,
): Promise<OperationResult> {
  const context = env.contexts[operation.context]
  if (context === undefined) throw new AppCardError('CONTEXT_MISSING', `Execution context ${operation.context} is unavailable`)
  let argv = programArgv(operation, input, declaration)
  const environment = Object.fromEntries(Object.entries(operation.env ?? {})
    .map(([key, value]) => [key, stringValue(value, input, declaration, `Environment ${key}`)]))
  const stdinData = operation.stdin === undefined ? undefined
    : stdinValue.parse({
      encoding: operation.stdin.encoding,
      value: resolveBinding(operation.stdin.value, { input, data: { ...declaration.data } }),
    })
  let stdin = stdinData === undefined ? undefined : stdinData.encoding === 'text' ? stdinData.value : JSON.stringify(stdinData.value)
  let cwd = context.cwd
  let spawnEnv: Record<string, string> | undefined = environment
  let completionMarker: string | undefined
  if (context.kind === 'ssh') {
    const [command, flag, config, alias, ...extra] = context.argvPrefix
    if (command !== 'ssh' || flag !== '-F' || !config || !alias || extra.length !== 0) {
      throw new AppCardError('SSH_CONTEXT_INVALID', 'SSH execution requires the exact reviewed ssh -F config alias prefix')
    }
    const ssh = await env.subprocess.resolveExecutable(command, undefined, clock.signal)
    // Only these read-only discovery commands may fall back. The reviewed operation runs once.
    await env.beforeStep?.()
    const {runtime} = await detectRemote(async (probe: string) => {
      clock.signal.throwIfAborted()
      const handle = env.subprocess.spawn({
        argv: [ssh, flag, config, alias, probe], cwd: dirname(config),
        signal: clock.signal, graceMs: env.limits.graceMs,
        stdio: {stdin:'ignore',stdout:{maxBytes:8192},stderr:{maxBytes:8192}},
      })
      let outcome
      try { outcome = await handle.done }
      finally {handle.terminate();await handle.waitForExit()}
      const stdout=handle.collected.stdout?.readFrom(0),stderr=handle.collected.stderr?.readFrom(0)
      if(clock.signal.aborted||outcome.signal!==null||outcome.exitCode===255) {
        throw new AppCardError('SSH_PREFLIGHT_FAILED','SSH discovery failed before the application command started; no operation was executed')
      }
      if(!stdout||!stderr||stdout.lossy||stderr.lossy) throw new AppCardError('SSH_PREFLIGHT_FAILED','Remote discovery returned missing or oversized output')
      if(outcome.exitCode!==0)throw Object.assign(new Error('Remote discovery command failed'),{code:outcome.exitCode,stderr:stderr.text})
      return {stdout:stdout.text}
    })
    const remote = remoteInvocation(runtime, {cwd:context.cwd,argv,env:environment,stdin})
    stdin = remote.stdin
    completionMarker = remote.completionMarker
    argv = [ssh, flag, config, alias, remote.command]
    cwd = dirname(config)
    spawnEnv = undefined
  } else {
    if (context.argvPrefix.length !== 0) throw new AppCardError('HOST_CONTEXT_INVALID', 'Host execution does not accept command prefixes')
    const executable = argv[0]
    if (executable === undefined) throw new AppCardError('EXECUTABLE_MISSING', 'Executable is required')
    argv[0] = await env.subprocess.resolveExecutable(executable, environment, clock.signal)
  }
  clock.signal.throwIfAborted()
  await env.beforeStep?.()
  clock.signal.throwIfAborted()
  const maxBytes = Math.min(operation.outputLimitBytes, env.limits.outputLimitBytes)
  const handle = env.subprocess.spawn({
    argv, cwd, env: spawnEnv, signal: clock.signal, graceMs: env.limits.graceMs,
    stdio: {
      stdin: stdin === undefined ? 'ignore' : { data: stdin },
      stdout: { maxBytes:maxBytes+(completionMarker?completionMarker.length+16:0) }, stderr: { maxBytes },
    },
  })
  let outcome
  try {
    outcome = await handle.done
  } finally {
    handle.terminate()
    await handle.waitForExit()
  }
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) throw new AppCardError('SUBPROCESS_PROTOCOL', 'Subprocess provider omitted collected output')
  const timedOut = clock.timedOut()
  const aborted = env.signal.aborted && !(env.signal.reason instanceof AppCardError && env.signal.reason.code === 'OPERATION_TIMEOUT')
  const completion = completionMarker && !stdout.lossy ? remoteCompletion(completionMarker,stdout.text) : undefined
  const payload=completion?.stdout ?? stdout.text
  const truncated = stdout.lossy || stderr.lossy || Buffer.byteLength(payload)>maxBytes
  const text = bytePrefix(payload, maxBytes)
  const exitCode=completionMarker ? completion?.exitCode ?? null : outcome.exitCode
  const process = {
    exitCode, signal: outcome.signal, timedOut, aborted, truncated,
    stderr: bytePrefix(stderr.text, maxBytes),
  }
  if (context.kind === 'ssh' && (clock.signal.aborted || outcome.exitCode === 255 || outcome.signal !== null || completionMarker && !completion)) {
    return {
      state: 'indeterminate', value: text, process,
      error: { code: 'REMOTE_UNCERTAIN', message: 'SSH ended without proving remote completion; remote processes may still be running. No retry was attempted.' },
    }
  }
  if (clock.signal.aborted) {
    return {
      ...failure(new AppCardError(timedOut ? 'OPERATION_TIMEOUT' : 'ABORTED', timedOut ? 'Operation exceeded timeoutMs' : 'Operation was cancelled'),
        timedOut ? 'failed' : 'cancelled'),
      value: text, process,
    }
  }
  if (truncated) {
    return { ...failure(new AppCardError('OUTPUT_TRUNCATED', 'Process output exceeded outputLimitBytes; incomplete JSON is not decoded')), value: text, process }
  }
  if (exitCode === null || !operation.successExitCodes.includes(exitCode)) {
    return { ...failure(new AppCardError('EXIT_CODE', `Process exited with ${exitCode ?? outcome.signal}`)), value: text, process }
  }
  try {
    const value = json.parse(operation.output.decode === 'text' ? text : JSON.parse(text))
    assertSchema(operation.output.schema, value, 'output')
    return { state: 'succeeded', value, process }
  } catch (error) {
    return { ...failure(error), value: text, process }
  }
}

type Invoke = (id: string, input: JsonValue, signal: AbortSignal, parents: ReadonlySet<string>) => Promise<OperationResult>

async function executeFlow(
  operation: FlowOperation,
  input: JsonValue,
  declaration: CardDeclaration,
  env: ExecutionEnvironment,
  clock: Deadline,
  invoke: Invoke,
  parents: ReadonlySet<string>,
): Promise<OperationResult> {
  const results: Record<string, OperationResult> = {}
  const pending = new Map(operation.steps.map(step => [step.id, step]))
  const running = new Map<string, Promise<void>>()
  const stop = new AbortController()
  const signal = AbortSignal.any([clock.signal, stop.signal])
  const stopState = { stopped: false }
  const scope = { input, data: { ...declaration.data }, steps: results }
  const launch = (step: FlowOperation['steps'][number]): void => {
    pending.delete(step.id)
    const task = (async () => {
      let result: OperationResult
      try {
        if (step.runAfter === 'success' && !step.after.every(id => results[id] !== undefined && succeeded(results[id]))) {
          result = { state: 'skipped', value: null, error: { code: 'DEPENDENCY_FAILED', message: 'A required dependency did not succeed' } }
        } else {
          const condition = step.when === undefined ? true : resolveBinding(step.when, scope)
          if (typeof condition !== 'boolean') throw new AppCardError('FLOW_CONDITION', `Condition for ${step.id} must resolve to boolean`)
          result = condition
            ? await invoke(step.operation, resolveBinding(step.input, scope), signal, parents)
            : { state: 'skipped', value: null }
        }
      } catch (error) {
        result = failure(error, signal.aborted ? 'cancelled' : 'failed')
      }
      results[step.id] = result
      if (!['succeeded', 'skipped', 'submitted'].includes(result.state) && step.onError === 'stop') {
        stopState.stopped = true
        stop.abort(new AppCardError('FLOW_STOPPED', `Flow stopped after step ${step.id}`))
      }
    })().finally(() => { running.delete(step.id) })
    running.set(step.id, task)
  }
  while (pending.size > 0 || running.size > 0) {
    if (!signal.aborted) {
      for (const step of pending.values()) {
        if (running.size >= Math.min(operation.concurrency, env.limits.concurrency)) break
        if (step.after.every(id => Object.hasOwn(results, id))) launch(step)
      }
    }
    if (running.size > 0) {
      await Promise.race(running.values())
    } else {
      if (pending.size > 0 && !signal.aborted) throw new AppCardError('FLOW_INVALID', 'Flow contains unresolved or cyclic dependencies')
      break
    }
  }
  for (const id of pending.keys()) results[id] = { state: 'skipped', value: null, error: { code: 'FLOW_STOPPED', message: 'Flow stopped before this step started' } }
  const uncertain = Object.values(results).some(result => result.state === 'indeterminate')
  const failed = Object.values(results).some(result => !['succeeded', 'skipped'].includes(result.state))
  if (clock.signal.aborted || stopState.stopped) {
    return {
      state: uncertain ? 'indeterminate' : clock.signal.aborted && !clock.timedOut() ? 'cancelled' : 'partial',
      value: null, steps: results,
      error: { code: clock.timedOut() ? 'OPERATION_TIMEOUT' : 'FLOW_STOPPED', message: 'Flow stopped; completed step outcomes are retained' },
    }
  }
  try {
    const value = resolveBinding(operation.output, scope)
    assertSchema(operation.outputSchema, value, 'flow output')
    return { state: uncertain ? 'indeterminate' : failed ? 'partial' : 'succeeded', value, steps: results }
  } catch (error) {
    return { ...failure(error, uncertain ? 'indeterminate' : 'partial'), steps: results }
  }
}

/** Execute one reviewed primitive graph without retries, detached work, authorization or storage.
 * All children settle before return. SSH transport loss reports uncertainty rather than claiming remote teardown.
 * @param declaration - validated immutable declaration.
 * @param operationId - declared entry point.
 * @param input - input checked against the entry point's object schema.
 * @param env - provider, reviewed contexts, limits and current-grant callback.
 * @returns terminal output with independent process facts and retained flow failures.
 */
export async function executeOperation(
  declaration: CardDeclaration,
  operationId: string,
  input: JsonValue,
  env: ExecutionEnvironment,
): Promise<OperationResult> {
  for (const [name, value] of Object.entries(env.limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new AppCardError('EXECUTION_LIMIT', `${name} must be a positive timer-sized integer`)
    }
  }
  const slots = new Slots(env.limits.concurrency)
  const invoke: Invoke = async (id, value, parentSignal, parents) => {
    if (!Object.hasOwn(declaration.operations, id)) throw new AppCardError('OPERATION_MISSING', `Unknown operation ${id}`)
    if (parents.has(id)) throw new AppCardError('OPERATION_CYCLE', `Recursive operation ${id} is not allowed`)
    const operation = declaration.operations[id]
    if (operation === undefined) throw new AppCardError('OPERATION_MISSING', `Unknown operation ${id}`)
    const clock = deadline(parentSignal, Math.min(operation.timeoutMs, env.limits.timeoutMs))
    const path = new Set([...parents, id])
    try {
      clock.signal.throwIfAborted()
      assertSchema(operation.inputSchema, value, 'input')
      let result: OperationResult
      if (operation.kind === 'flow') {
        result = await executeFlow(operation, value, declaration, env, clock, invoke, path)
      } else {
        result = await slots.run(clock.signal, async () => {
          switch (operation.kind) {
            case 'exec': return executeProcess(operation, value, declaration, env, clock)
            case 'transform': {
              const output = await evaluateExpression(operation.source,
                resolveBinding(operation.input, { input: value, data: { ...declaration.data } }),
                {
                  timeoutMs: Math.min(operation.timeoutMs, env.limits.timeoutMs),
                  outputLimitBytes: env.limits.outputLimitBytes, signal: clock.signal,
                })
              assertSchema(operation.outputSchema, output, 'transform output')
              return { state: 'succeeded', value: output }
            }
            case 'agent': {
              await env.beforeStep?.()
              clock.signal.throwIfAborted()
              const taskInput = resolveBinding(operation.input, { input: value, data: { ...declaration.data } })
              const output = await env.runAgent(operation, taskInput, clock.signal)
              if (clock.signal.aborted) return failure(clock.signal.reason, clock.timedOut() ? 'failed' : 'cancelled')
              if (output.state === 'succeeded') assertSchema(operation.outputSchema, output.value, 'agent output')
              return output
            }
          }
        })
      }
      return boundResult(result, env.limits.outputLimitBytes)
    } catch (error) {
      return boundResult(failure(error, clock.signal.aborted && !clock.timedOut() ? 'cancelled' : 'failed'), env.limits.outputLimitBytes)
    } finally {
      clock.close()
    }
  }
  return invoke(operationId, input, env.signal, new Set())
}
