import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isObserving, parseDeclaration, resolveBinding } from '../src/declaration.ts'
import { expandPresets } from '../src/presets.ts'
import type { CardDeclaration, FlowOperation, JsonValue, Operation } from '../src/types.ts'

const minimal: unknown = JSON.parse(readFileSync(new URL('../examples/minimal.json', import.meta.url), 'utf8'))
const inputSchema = { type: 'object' as const }

function declaration(operations?: Record<string, Operation>): CardDeclaration {
  const base = parseDeclaration(minimal)
  return operations === undefined ? base : { ...base, operations, actions: {}, checks: {} }
}

function flow(operation: string): FlowOperation {
  return {
    kind: 'flow', inputSchema, timeoutMs: 1000, concurrency: 2, outputSchema: {},
    steps: [{ id: 'first', operation, after: [], input: { literal: {} }, runAfter: 'success', onError: 'stop' }],
    output: { ref: '/steps/first/value' },
  }
}

describe('strict application declarations', () => {
  it('parses a detached declaration without changing authority fields', () => {
    const parsed = parseDeclaration(minimal)
    expect(parsed).toEqual(minimal)
    expect(parsed).not.toBe(minimal)
  })

  it.each(['effect', 'context', 'inputSchema', 'timeoutMs', 'successExitCodes', 'outputLimitBytes'])('requires exec %s explicitly', (field) => {
    const parsed = declaration()
    const exec = Object.fromEntries(Object.entries(parsed.operations['say']!).filter(([key]) => key !== field))
    expect(() => parseDeclaration({ ...parsed, operations: { say: exec } })).toThrow()
  })

  it('rejects unsupported primitives, fields and unenforced JSON Schema keywords', () => {
    const base = declaration()
    for (const replacement of [
      { ...base.operations['say'], kind: 'service-restart' },
      { ...base.operations['say'], approved: true },
      { ...base.operations['say'], inputSchema: { type: 'object', minProperties: 1 } },
      { ...base.operations['say'], timeoutMs: 0 },
      { ...base.operations['say'], inputSchema: { type: 'array' } },
    ]) expect(() => parseDeclaration({ ...base, operations: { say: replacement } })).toThrow()
    expect(() => parseDeclaration({ ...base, granted: true })).toThrow()
  })

  it('rejects missing contexts, operations, apps and checks', () => {
    const base = declaration()
    const candidates = [
      { ...base, contexts: {} }, { ...base, operations: {} }, { ...base, apps: {} },
      { ...base, actions: { say: { ...base.actions['say'], invalidates: ['unknown'] } } },
      { ...base, actions: { say: { ...base.actions['say'], availability: { kind: 'check', checkId: 'unknown', source: 'true' } } } },
    ]
    for (const candidate of candidates) expect(() => parseDeclaration(candidate)).toThrow(/unknown/u)
  })

  it('rejects step cycles, unknown dependencies and references without ordering', () => {
    const base = declaration()
    const first = flow('say').steps[0]!
    for (const steps of [
      [{ ...first, after: ['unknown'] }],
      [{ ...first, after: ['first'] }],
      [first, first],
      [first, { ...first, id: 'second', input: { ref: '/steps/first/value' } }],
    ]) {
      expect(() => parseDeclaration(declaration({ say: base.operations['say']!, graph: { ...flow('say'), steps } }))).toThrow()
    }
  })

  it('accepts ancestor and escaped static data references but rejects missing data', () => {
    const base = declaration()
    const graph = flow('say')
    const first = graph.steps[0]
    if (first === undefined) throw new Error('Fixture flow requires a first step')
    const value = parseDeclaration({
      ...declaration({ say: base.operations['say']!, graph: {
        ...graph, steps: [
          first, { ...first, id: 'second', after: ['first'], input: { ref: '/steps/first/value' } },
        ],
      } }),
      data: { 'a/b': { '~key': true } },
    })
    expect(resolveBinding({ ref: '/data/a~1b/~0key' }, { input: {}, data: { ...value.data } })).toBe(true)
    expect(() => parseDeclaration({ ...base, actions: { say: { ...base.actions['say'], input: { ref: '/data/absent' } } } })).toThrow(/Missing binding/u)
  })

  it('rejects operation cycles through flows and agent allowedOperations', () => {
    const graph = flow('agent')
    const agent = {
      kind: 'agent' as const, inputSchema, timeoutMs: 1000, input: { literal: {} }, prompt: 'Inspect',
      completion: 'result' as const, allowedOperations: ['graph'], outputSchema: {},
    }
    expect(() => parseDeclaration(declaration({ graph, agent }))).toThrow(/cycle/u)
  })

  it('rejects a check that reaches change through an agent and flow', () => {
    const base = declaration()
    const exec = base.operations['say']!
    if (exec.kind !== 'exec') throw new Error('Expected exec fixture')
    const operations: Record<string, Operation> = {
      say: { ...exec, effect: 'change' }, graph: flow('say'),
      report: {
        kind: 'agent', inputSchema, timeoutMs: 1000, input: { literal: {} }, prompt: 'Inspect',
        completion: 'result', allowedOperations: ['graph'], outputSchema: {},
      },
    }
    expect(isObserving({ ...base, operations }, 'report')).toBe(false)
    expect(() => parseDeclaration({
      ...base, operations, checks: { available: { ...base.checks['available'], operation: 'report' } },
    })).toThrow(/reaches a change/u)
    expect(isObserving(base, 'say')).toBe(true)
    expect(() => isObserving(base, 'missing')).toThrow(/unknown/u)
  })

  it('expands all supported presets before strict declaration parsing', () => {
    const base = declaration()
    const exec = base.operations['say']!
    if (exec.kind !== 'exec' || exec.program.kind !== 'argv') throw new Error('Expected argv fixture')
    const { kind: _kind, program, ...fields } = exec
    const command = { kind: 'command', ...fields, executable: program.executable, args: program.args }
    expect(parseDeclaration({ ...base, operations: { say: command } }).operations['say']).toEqual(exec)
    const { effect: _effect, ...probeFields } = fields
    expect(parseDeclaration({ ...base, operations: { say: {
      kind: 'probe', ...probeFields, executable: program.executable, args: program.args,
    } } }).operations['say']).toEqual(exec)
    const expanded = expandPresets({ operations: {
      shell: { kind: 'script', interpreter: 'sh', source: 'printf ok', args: [] },
      task: { kind: 'agent-task' }, report: { kind: 'inspection-report' },
    } })
    expect(expanded).toEqual({ operations: {
      shell: { kind: 'exec', program: { kind: 'script', interpreter: 'sh', source: 'printf ok', args: [] } },
      task: { kind: 'agent' }, report: { kind: 'flow' },
    } })
    expect(() => expandPresets({ operations: { bad: { ...command, program } } })).toThrow(/override/u)
    expect(() => expandPresets({ operations: { bad: { ...command, kind: 'probe' } } })).toThrow(/override/u)
  })

  it('rejects non-JSON and prototype-named record keys rather than dropping them', () => {
    expect(() => parseDeclaration({ ...declaration(), extra: undefined })).toThrow(/lossless JSON/u)
    const base = declaration()
    const unsafe: unknown = JSON.parse('{"__proto__":{}}')
    expect(() => parseDeclaration({ ...base, data: unsafe })).toThrow()
  })
})

describe('structural bindings', () => {
  const scope = { input: { label: '$(do not run); ${literal}', list: ['first'] }, data: { fixed: 3 } }

  it('preserves literal strings and binds arrays and objects without substitution', () => {
    expect(resolveBinding({ object: {
      label: { ref: '/input/label' }, untouched: { literal: '${input.label}' },
      values: { array: [{ ref: '/data/fixed' }, { ref: '/input/list/0' }] },
    } }, scope)).toEqual({ label: '$(do not run); ${literal}', untouched: '${input.label}', values: [3, 'first'] })
    expect(resolveBinding({ ref: '/input' }, scope)).toEqual(scope.input)
  })

  it.each(['/input/missing', '/input/list/01', '/input/list/length', '/steps/unknown', '/input/label/deeper'])('rejects missing or non-JSON pointer %s', (ref) => {
    expect(() => resolveBinding({ ref }, scope)).toThrow()
  })

  it.each(['input/label', '/other', '/input/~2', '/input/__proto__', '/input/constructor/prototype'])('rejects unsafe pointer %s', (ref) => {
    expect(() => resolveBinding({ ref }, scope)).toThrow()
  })

  it('does not read inherited values', () => {
    const inherited: JsonValue = {}
    Object.setPrototypeOf(inherited, { hidden: true })
    expect(() => resolveBinding({ ref: '/input/hidden' }, { input: inherited, data: {} })).toThrow()
  })
})
