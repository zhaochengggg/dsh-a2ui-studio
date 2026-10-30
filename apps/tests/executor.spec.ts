import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDeclaration } from '../src/declaration.ts'
import { executeOperation } from '../src/executor.ts'
import type { ExecutionEnvironment } from '../src/executor.ts'
import type { Binding, CardDeclaration, ExecOperation, FlowOperation, Operation } from '../src/types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "dsh-app-exec-'"))
  cleanups.push(() => rm(cwd, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(LocalSubprocess)
  cleanups.push(() => ctx.fiber.dispose())
  const base = parseDeclaration(JSON.parse(await readFile(new URL('../examples/minimal.json', import.meta.url), 'utf8')))
  const controller = new AbortController()
  const env: ExecutionEnvironment = {
    subprocess: ctx.subprocess, contexts: { local: { kind: 'host', cwd, argvPrefix: [], identity: 'test', display: 'test' } },
    signal: controller.signal, limits: { timeoutMs: 5000, outputLimitBytes: 65536, concurrency: 2, graceMs: 50 },
    runAgent: async () => { throw new Error('Unexpected agent invocation') },
  }
  const declaration = (operations: Record<string, Operation>): CardDeclaration =>
    parseDeclaration({ ...base, operations, contexts: { local: { kind: 'host', cwd } }, actions: {}, checks: {} })
  return { ctx, cwd, controller, env, declaration }
}

function node(source: string, args: readonly Binding[] = []): ExecOperation {
  return {
    kind: 'exec', effect: 'observe', context: 'local', inputSchema: { type: 'object' },
    timeoutMs: 5000, outputLimitBytes: 8192, successExitCodes: [0],
    program: { kind: 'argv', executable: process.execPath, args: [{ literal: '-e' }, { literal: source }, ...args] },
    output: { decode: 'json', schema: {} },
  }
}

function graph(steps: FlowOperation['steps'], output: Binding = { literal: { complete: true } }): FlowOperation {
  return { kind: 'flow', inputSchema: { type: 'object' }, timeoutMs: 5000, concurrency: 2, steps, output, outputSchema: {} }
}

function step(id: string, operation = id, after: readonly string[] = []): FlowOperation['steps'][number] {
  return { id, operation, after, runAfter: 'success', input: { literal: {} }, onError: 'continue' }
}

describe('application operation execution', () => {
  it.skipIf(process.platform !== 'win32')('executes explicit PowerShell argv on Windows', async () => {
    const {env,declaration}=await setup()
    const operation: ExecOperation={...node(''),program:{
      kind:'argv',executable:'powershell.exe',args:[
        {literal:'-NoProfile'},{literal:'-NonInteractive'},{literal:'-Command'},
        {literal:"[Console]::Write('{\"platform\":\"windows\",\"readonly\":true}')"},
      ],
    }}
    expect(await executeOperation(declaration({run:operation}),'run',{},env))
      .toMatchObject({state:'succeeded',value:{platform:'windows',readonly:true}})
  })
  it('passes argv and env as literal values and rechecks authority immediately before spawn', async () => {
    const { env, declaration } = await setup()
    const beforeStep = vi.fn(async () => {})
    const malicious = "'; $(printf injected); `printf injected`\n\"\\${HOME}"
    const operation: ExecOperation = {
      ...node('process.stdout.write(JSON.stringify({args:process.argv.slice(1),env:process.env.CARD_VALUE}))', [{ ref: '/input/argument' }]),
      env: { CARD_VALUE: { ref: '/input/argument' } },
    }
    const result = await executeOperation(declaration({ run: operation }), 'run', { argument: malicious }, { ...env, beforeStep })
    expect(result).toMatchObject({
      state: 'succeeded', value: { args: [malicious], env: malicious },
      process: { exitCode: 0, signal: null, timedOut: false, aborted: false, truncated: false },
    })
    expect(beforeStep).toHaveBeenCalledTimes(1)
  })

  it('requires string arguments and denies revoked grants before any process starts', async () => {
    const { env, declaration } = await setup()
    const spawn = vi.spyOn(env.subprocess, 'spawn')
    const operation = node('console.log(1)', [{ ref: '/input/argument' }])
    expect(await executeOperation(declaration({ run: operation }), 'run', { argument: 1 }, env))
      .toMatchObject({ state: 'failed', error: { code: 'BINDING_TYPE' } })
    expect(await executeOperation(declaration({ run: node('console.log(1)') }), 'run', {}, {
      ...env, beforeStep: async () => { throw new Error('Grant withdrawn') },
    })).toMatchObject({ state: 'failed', error: { message: 'Grant withdrawn' } })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('serializes explicit text and JSON stdin without interpreting their contents', async () => {
    const { env, declaration } = await setup()
    const read = node('let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>input+=s);process.stdin.on("end",()=>console.log(JSON.stringify(input)))')
    for (const encoding of ['text', 'json'] as const) {
      const operation = { ...read, stdin: { encoding, value: { ref: '/input/value' } } }
      const value = encoding === 'text' ? 'raw\n$(printf NO)' : { list: [1, 'é'] }
      const result = await executeOperation(declaration({ run: operation }), 'run', { value }, env)
      expect(result).toMatchObject({ state: 'succeeded', value: encoding === 'text' ? value : JSON.stringify(value) })
    }
    expect(await executeOperation(declaration({ run: { ...read, stdin: { encoding: 'text', value: { literal: {} } } } }), 'run', {}, env))
      .toMatchObject({ state: 'failed' })
  })

  it.skipIf(process.platform === 'win32')('executes complete POSIX scripts with exact positional arguments and independent stdin', async () => {
    const { env, declaration } = await setup()
    const operation: ExecOperation = {
      ...node(''), output: { decode: 'text', schema: { type: 'string' } },
      program: { kind: 'script', interpreter: 'sh', source: 'printf "%s\\n" "$1"; cat', args: [{ ref: '/input/value' }] },
      stdin: { encoding: 'text', value: { literal: 'stdin without newline' } },
    }
    const value = "'; printf INJECTION; #"
    expect(await executeOperation(declaration({ run: operation }), 'run', { value }, env))
      .toMatchObject({ state: 'succeeded', value: `${value}\nstdin without newline` })
    expect(await executeOperation(declaration({ run: {
      ...operation, program: { ...operation.program, kind: 'script', interpreter: 'unknown-interpreter', source: 'code', args: [] },
    } }), 'run', {}, env)).toMatchObject({ state: 'failed', error: { code: 'INTERPRETER_UNSUPPORTED' } })
  })

  it('preserves unaccepted exit, accepted nonzero exit and malformed output independently', async () => {
    const { env, declaration } = await setup()
    const nonzero = node('console.log("7");process.exitCode=7')
    expect(await executeOperation(declaration({ run: nonzero }), 'run', {}, env))
      .toMatchObject({ state: 'failed', value: '7\n', process: { exitCode: 7 }, error: { code: 'EXIT_CODE' } })
    expect(await executeOperation(declaration({ run: { ...nonzero, successExitCodes: [7] } }), 'run', {}, env))
      .toMatchObject({ state: 'succeeded', value: 7, process: { exitCode: 7 } })
    expect(await executeOperation(declaration({ run: node('console.log("not JSON")') }), 'run', {}, env))
      .toMatchObject({ state: 'failed', value: 'not JSON\n', process: { exitCode: 0 } })
    expect(await executeOperation(declaration({ run: { ...node('console.log(1)'), output: { decode: 'json', schema: { type: 'string' } } } }), 'run', {}, env))
      .toMatchObject({ state: 'failed', process: { exitCode: 0 }, error: { code: 'SCHEMA_MISMATCH' } })
  })

  it('caps both streams and never decodes a complete-looking JSON tail after truncation', async () => {
    const { env, declaration } = await setup()
    const operation = { ...node('process.stdout.write(" ".repeat(1000)+"1");process.stderr.write("é".repeat(1000))'), outputLimitBytes: 31 }
    const result = await executeOperation(declaration({ run: operation }), 'run', {}, env)
    expect(result).toMatchObject({ state: 'failed', error: { code: 'OUTPUT_TRUNCATED' }, process: { truncated: true } })
    expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(33)
    expect(Buffer.byteLength(result.process?.stderr ?? '')).toBeLessThanOrEqual(31)
  })

  it('retains timeout even when a signal handler exits zero and awaits process-tree quiescence', async () => {
    const { env, declaration } = await setup()
    const spawn = vi.spyOn(env.subprocess, 'spawn')
    // Allow a cold Node process to register SIGTERM under parallel test load.
    // The assertion below still requires a timed-out operation and exit code 0.
    const operation = { ...node('process.on("SIGTERM",()=>{console.log(0);process.exit(0)});setInterval(()=>{},1000)'), timeoutMs: 1500 }
    const result = await executeOperation(declaration({ run: operation }), 'run', {}, env)
    expect(result).toMatchObject({ state: 'failed', process: { timedOut: true, aborted: false } })
    // Windows forcibly terminates the tree; POSIX delivers the catchable signal.
    if (process.platform !== 'win32') expect(result.process?.exitCode).toBe(0)
    else expect(result.process?.exitCode).not.toBeNull()
    const record = spawn.mock.results[0]
    if (record?.type !== 'return') throw new Error('Expected a spawned process handle')
    const handle: ReturnType<ExecutionEnvironment['subprocess']['spawn']> = record.value
    expect(await handle.waitForExit(AbortSignal.timeout(100))).toBe(true)
  })

  it('cancels running work and does not spawn work with an already-aborted signal', async () => {
    const { env, controller, declaration } = await setup()
    const original = env.subprocess.spawn.bind(env.subprocess)
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const spawn = vi.spyOn(env.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = original(spec)
      started()
      return handle
    })
    const document = declaration({ run: node('setInterval(()=>{},1000)') })
    const pending = executeOperation(document, 'run', {}, env)
    await ready
    controller.abort()
    const result = await pending
    expect(result.state).toBe('cancelled')
    if (result.process) expect(result.process.aborted).toBe(true)
    const spawned = spawn.mock.results[0]
    if (spawned?.type !== 'return') throw new Error('No spawned handle')
    expect(await spawned.value.waitForExit(AbortSignal.timeout(2000))).toBe(true)
    expect(await executeOperation(document, 'run', {}, env)).toMatchObject({ state: 'cancelled' })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('quotes SSH command data without modifying the reviewed prefix or running SSH in tests', async () => {
    const { env, cwd, declaration } = await setup()
    const original = env.subprocess.spawn.bind(env.subprocess)
    const captured: SubprocessSpawnSpec[] = []
    vi.spyOn(env.subprocess, 'resolveExecutable').mockResolvedValue('/resolved/ssh')
    vi.spyOn(env.subprocess, 'spawn').mockImplementation((spec) => {
      captured.push(spec)
      const remote = spec.argv[4]
      if (remote === undefined) throw new Error('Missing remote command')
      return original({ ...spec, argv: ['/bin/sh', '-c', remote], cwd })
    })
    const argument = "'; echo injected; #\n$(echo injected) `echo injected`"
    const operation: ExecOperation = {
      ...node('console.log(JSON.stringify({arg:process.argv[1],env:process.env.VALUE}))', [{ ref: '/input/value' }]),
      env: { VALUE: { ref: '/input/value' } },
    }
    const remoteEnv = { ...env, contexts: { local: { kind: 'ssh' as const, cwd, argvPrefix: ['ssh', '-F', '/tmp/reviewed.conf', 'reviewed-alias'], identity: 'test', display: 'ssh' } } }
    const result = await executeOperation(declaration({ run: operation }), 'run', { value: argument }, remoteEnv)
    expect(result).toMatchObject({ state: 'succeeded', value: { arg: argument, env: argument } })
    expect(captured[0]?.argv.slice(0, 4)).toEqual(['/resolved/ssh', '-F', '/tmp/reviewed.conf', 'reviewed-alias'])
    expect(captured[0]?.cwd).toBe('/tmp')
    expect(captured[0]?.env).toBeUndefined()
  })

  it('reports remote transport failure as indeterminate without retry', async () => {
    const { env, cwd, declaration } = await setup()
    const original = env.subprocess.spawn.bind(env.subprocess)
    vi.spyOn(env.subprocess, 'resolveExecutable').mockResolvedValue('/resolved/ssh')
    let calls=0
    const spawn = vi.spyOn(env.subprocess, 'spawn').mockImplementation(spec => original({
      ...spec, cwd, argv: [process.execPath, '-e', ++calls===1?'console.log("DSH_MACHINE_OK\\nhost")':'process.exitCode=255'],
    }))
    const result = await executeOperation(declaration({ run: node('console.log(1)') }), 'run', {}, {
      ...env, contexts: { local: { kind: 'ssh', cwd: '/tmp', argvPrefix: ['ssh', '-F', '/tmp/config', 'alias'], identity: 'test', display: 'ssh' } },
    })
    expect(result).toMatchObject({ state: 'indeterminate', process: { exitCode: 255 }, error: { code: 'REMOTE_UNCERTAIN' } })
    expect(spawn).toHaveBeenCalledTimes(2) // one read-only discovery, one operation; never retry it
  })

  it('fails before executing the operation when SSH discovery fails',async()=>{
    const {env,cwd,declaration}=await setup()
    const original=env.subprocess.spawn.bind(env.subprocess)
    vi.spyOn(env.subprocess,'resolveExecutable').mockResolvedValue('/resolved/ssh')
    const spawn=vi.spyOn(env.subprocess,'spawn').mockImplementation(spec=>original({...spec,cwd,argv:[process.execPath,'-e','process.exitCode=255']}))
    expect(await executeOperation(declaration({run:node('console.log(1)')}),'run',{}, {
      ...env,contexts:{local:{kind:'ssh',cwd:'/tmp',argvPrefix:['ssh','-F','/tmp/config','alias'],identity:'test',display:'ssh'}},
    })).toMatchObject({state:'failed',error:{code:'SSH_PREFLIGHT_FAILED'}})
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('reserves Windows completion framing outside the application output limit',async()=>{
    const {env,cwd,declaration}=await setup()
    const original=env.subprocess.spawn.bind(env.subprocess)
    vi.spyOn(env.subprocess,'resolveExecutable').mockResolvedValue('/resolved/ssh')
    let count=0,length=255
    vi.spyOn(env.subprocess,'spawn').mockImplementation(spec=>{
      count++
      let source=count%3===1?'process.exitCode=127':count%3===2?'console.log("DSH_MACHINE_OK\\nhost")':
       `let s="";process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>{const h=JSON.parse(Buffer.from(s.split("\\n")[0],"base64").toString());process.stdout.write("x".repeat(${length})+"\\n"+h.marker+"0\\n")})`
      return original({...spec,cwd,argv:[process.execPath,'-e',source]})
    })
    const operation={...node(''),outputLimitBytes:256,output:{decode:'text' as const,schema:{type:'string' as const}}}
    const remote={...env,contexts:{local:{kind:'ssh' as const,cwd:'C:\\test',argvPrefix:['ssh','-F','/tmp/config','alias'],identity:'test',display:'ssh'}}}
    for(length of [255,256,257,1024]){
      const r=await executeOperation(declaration({run:operation}),'run',{},remote)
      if(length<=256)expect(r).toMatchObject({state:'succeeded',value:'x'.repeat(length)})
      else if(length===257)expect(r).toMatchObject({state:'failed',error:{code:'OUTPUT_TRUNCATED'}})
      else expect(r).toMatchObject({state:'indeterminate',process:{exitCode:null,truncated:true},error:{code:'REMOTE_UNCERTAIN'}})
    }
  })

  it('executes pure transforms and schema-validates explicit agent results', async () => {
    const { env, declaration } = await setup()
    const operations: Record<string, Operation> = {
      transform: { kind: 'transform', inputSchema: { type: 'object' }, timeoutMs: 2000, source: '$sum(values)', input: { ref: '/input' }, outputSchema: { type: 'number' } },
      agent: { kind: 'agent', inputSchema: { type: 'object' }, timeoutMs: 2000, prompt: 'Summarize', input: { ref: '/input' }, allowedOperations: [], completion: 'result', outputSchema: { type: 'string' } },
    }
    expect(await executeOperation(declaration(operations), 'transform', { values: [1, 2] }, env))
      .toMatchObject({ state: 'succeeded', value: 3 })
    const beforeStep = vi.fn(async () => {})
    expect(await executeOperation(declaration(operations), 'agent', {}, {
      ...env, beforeStep, runAgent: async () => ({ state: 'succeeded', value: 4 }),
    })).toMatchObject({ state: 'failed', error: { code: 'SCHEMA_MISMATCH' } })
    expect(beforeStep).toHaveBeenCalledOnce()
  })
})

describe('finite flows', () => {
  it('retains failed probe evidence even when a settled synthesis succeeds', async () => {
    const { env, declaration } = await setup()
    const operations: Record<string, Operation> = {
      good: node('console.log("{\\"ok\\":true}")'),
      bad: node('console.log("probe failed");process.exitCode=3'),
      summarize: {
        kind: 'transform', inputSchema: { type: 'object' }, timeoutMs: 2000,
        input: { ref: '/input' }, source: '{"summary":"partial", "state": failed.state}', outputSchema: {},
      },
      flow: graph([
        step('good'), step('bad'),
        { ...step('summary', 'summarize', ['good', 'bad']), runAfter: 'settled', input: { object: { failed: { ref: '/steps/bad' } } } },
      ], { ref: '/steps/summary/value' }),
    }
    const result = await executeOperation(declaration(operations), 'flow', {}, env)
    expect(result).toMatchObject({
      state: 'partial', value: { summary: 'partial', state: 'failed' },
      steps: { good: { state: 'succeeded' }, bad: { state: 'failed', process: { exitCode: 3 } }, summary: { state: 'succeeded' } },
    })
  })

  it('skips success-only dependencies and requires boolean conditions', async () => {
    const { env, declaration } = await setup()
    const operations: Record<string, Operation> = {
      bad: node('process.exitCode=1'), good: node('console.log(1)'),
      flow: graph([
        step('bad'), step('blocked', 'good', ['bad']),
        { ...step('conditional', 'good'), when: { literal: 'truthy' } },
        { ...step('false', 'good'), when: { literal: false } },
      ]),
    }
    const result = await executeOperation(declaration(operations), 'flow', {}, env)
    expect(result).toMatchObject({
      state: 'partial', steps: {
        blocked: { state: 'skipped', error: { code: 'DEPENDENCY_FAILED' } },
        conditional: { state: 'failed', error: { code: 'FLOW_CONDITION' } }, false: { state: 'skipped' },
      },
    })
  })

  it('honors dependency order and a shared concurrency ceiling across nested flows', async () => {
    const { env, declaration } = await setup()
    const original = env.subprocess.spawn.bind(env.subprocess)
    let active = 0
    let maximum = 0
    vi.spyOn(env.subprocess, 'spawn').mockImplementation((spec) => {
      active++
      maximum = Math.max(maximum, active)
      const handle = original(spec)
      void handle.done.then(() => { active-- })
      return handle
    })
    const document = declaration({
      one: node('setTimeout(()=>console.log(1),40)'),
      nested: graph([step('first', 'one'), step('second', 'one'), step('third', 'one', ['first', 'second'])]),
      flow: graph([step('left', 'nested'), step('right', 'nested')]),
    })
    const result = await executeOperation(document, 'flow', {}, env)
    expect(result.state).toBe('succeeded')
    expect(maximum).toBe(2)
    expect(active).toBe(0)
  })

  it('stops after failure, cancels running peers and never starts dependent work', async () => {
    const { env, declaration } = await setup()
    const beforeStep = vi.fn(async () => {})
    const document = declaration({
      bad: node('setTimeout(()=>process.exit(3),70)'),
      long: node('setInterval(()=>{},1000)'), after: node('console.log(1)'),
      flow: graph([{ ...step('bad'), onError: 'stop' }, step('long'), step('after', 'after', ['bad', 'long'])]),
    })
    const result = await executeOperation(document, 'flow', {}, { ...env, beforeStep })
    expect(result).toMatchObject({ state: 'partial', steps: {
      bad: { state: 'failed' }, long: { state: 'cancelled' }, after: { state: 'skipped' },
    } })
    expect(beforeStep).toHaveBeenCalledTimes(2)
  })

  it('does not leave an agent callback running after flow cancellation', async () => {
    const { env, controller, declaration } = await setup()
    let settled = false
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const document = declaration({
      agent: { kind: 'agent', inputSchema: { type: 'object' }, timeoutMs: 1000, prompt: 'Inspect', input: { ref: '/input' }, completion: 'result', allowedOperations: [], outputSchema: {} },
      flow: graph([step('agent')]),
    })
    const pending = executeOperation(document, 'flow', {}, {
      ...env, runAgent: async (_operation, _input, signal) => {
        started()
        await new Promise<void>((resolve) =>{  signal.addEventListener('abort', () =>{  resolve() }, { once: true }) })
        await sleep(10)
        settled = true
        return { state: 'cancelled', value: null }
      },
    })
    await ready
    controller.abort()
    expect((await pending).state).toBe('cancelled')
    expect(settled).toBe(true)
  })
})
