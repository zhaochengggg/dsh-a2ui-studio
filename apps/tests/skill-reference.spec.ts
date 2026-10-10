import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDeclaration } from '../src/declaration.ts'
import { evaluateExpression } from '../src/expression.ts'
import { validateUi } from '../src/ui-catalog.ts'

const source = readFileSync(new URL('../skills/app-cards-authoring/references/service-card.md', import.meta.url), 'utf8')
const blocks = [...source.matchAll(/^```json\n([\s\S]*?)^```/gmu)]
const card = parseDeclaration(JSON.parse(blocks[0]![1]!))

describe('the shipped service-card reference', () => {
  it('parses the actual fenced declaration and validates its UI without remote execution', () => {
    expect(blocks).toHaveLength(1)
    expect(() => { validateUi(card) }).not.toThrow()
    expect(card.machineId).toBe('example-host')
    expect(Object.keys(card.operations)).toEqual(['start', 'stop', 'inspectUnit', 'probeHttp'])
    for (const operation of Object.values(card.operations)) {
      expect(operation.kind).toBe('exec')
      if (operation.kind !== 'exec') throw new Error('Example must use fixed argv operations')
      expect(operation.program.kind).toBe('argv')
      if (operation.effect === 'change') expect(operation.successExitCodes).toEqual([0])
    }
    for (const action of Object.values(card.actions)) expect(action.invalidates).toEqual(['unitState', 'httpReady'])
  })

  it.each([
    ['unitState', 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nResult=success\n', 0, 'healthy'],
    ['unitState', 'LoadState=loaded\nActiveState=inactive\nSubState=dead\n', 0, 'unhealthy'],
    ['unitState', 'LoadState=loaded\nActiveState=failed\nSubState=failed\n', 0, 'unhealthy'],
    ['unitState', 'LoadState=loaded\nActiveState=activating\nSubState=start\n', 0, 'unhealthy'],
    ['unitState', 'LoadState=not-found\nActiveState=inactive\nSubState=dead\n', 0, 'unknown'],
    ['unitState', '', 0, 'unknown'],
    ['httpReady', '200', 0, 'healthy'],
    ['httpReady', '404', 0, 'unhealthy'],
    ['httpReady', '500', 0, 'unhealthy'],
    ['httpReady', '301', 0, 'unhealthy'],
    ['httpReady', '000', 7, 'unhealthy'],
    ['httpReady', '000', 28, 'unhealthy'],
  ])('interprets %s output %j with completed probe exit %i as %s', async (id, value, exitCode, health) => {
    const result = await evaluateExpression(card.checks[id]!.evaluate.source, {
      state: 'succeeded', value,
      process: { exitCode, stderr: '', signal: null, timedOut: false, aborted: false, truncated: false },
    }, { timeoutMs: 5000, outputLimitBytes: 8192 })
    expect(result).toHaveProperty('health', health)
    expect(result).toHaveProperty('summary', expect.any(String))
  })

  it.each([
    ['invented primitive', { ...card.operations.start, kind: 'service' }],
    ['unbound argv', { ...card.operations.start, program: { kind: 'argv', executable: 'service', args: ['start'] } }],
  ])('rejects %s in the example', (_label, start) => {
    expect(() => parseDeclaration({ ...card, operations: { ...card.operations, start } })).toThrow()
  })

  it('rejects a mutation used as a check', () => {
    expect(() => parseDeclaration({
      ...card, checks: { ...card.checks, unitState: { ...card.checks.unitState, operation: 'start' } },
    })).toThrow()
  })
})
