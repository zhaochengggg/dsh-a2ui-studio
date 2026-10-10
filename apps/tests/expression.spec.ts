import { describe, expect, it } from 'vitest'
import { evaluateExpression } from '../src/expression.ts'

const options = { timeoutMs: 2000, outputLimitBytes: 65536 }

describe('isolated JSONata', () => {
  it('evaluates pure expressions in a real worker and returns detached JSON', async () => {
    const input = { values: [2, 3, 4] }
    expect(await evaluateExpression('{"total": $sum(values), "items": values}', input, options))
      .toEqual({ total: 9, items: [2, 3, 4] })
  })

  it.each([
    '$eval("1+1")', '($run := $eval; $run("1+1"))', '$getenv("PATH")', '$sum', 'missing', '$', 'not valid JSONata ]',
  ])('rejects unavailable or non-JSON expression %s', async (source) => {
    const input = source === '$' ? null : {}
    if (source === '$') {
      expect(await evaluateExpression(source, input, options)).toBeNull()
    } else {
      await expect(evaluateExpression(source, input, options)).rejects.toThrow()
    }
  })

  it('measures complete serialized UTF-8 output including quotes at the exact limit', async () => {
    expect(await evaluateExpression('"é"', {}, { ...options, outputLimitBytes: 4 })).toBe('é')
    await expect(evaluateExpression('"é"', {}, { ...options, outputLimitBytes: 3 })).rejects.toMatchObject({ code: 'EXPRESSION_OUTPUT_LIMIT' })
    expect(await evaluateExpression('0', {}, { ...options, outputLimitBytes: 1 })).toBe(0)
    await expect(evaluateExpression('"large"', {}, { ...options, outputLimitBytes: 1 })).rejects.toMatchObject({ code: 'EXPRESSION_OUTPUT_LIMIT' })
  })

  it('terminates nonterminating expressions on a wall-clock deadline', async () => {
    await expect(evaluateExpression('($loop := function(){ $loop() }; $loop())', {}, { ...options, timeoutMs: 100 }))
      .rejects.toMatchObject({ code: 'EXPRESSION_TIMEOUT' })
    expect(await evaluateExpression('1+1', {}, options)).toBe(2)
  })

  it('terminates on cancellation and rejects cancellation before creating work', async () => {
    const controller = new AbortController()
    const pending = evaluateExpression('($loop := function(){ $loop() }; $loop())', {}, { ...options, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    await expect(evaluateExpression('1', {}, { ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it.each([0, -1, 0.5, Infinity, 2_147_483_648])('rejects invalid deadlines %s', async (timeoutMs) => {
    await expect(evaluateExpression('1', {}, { ...options, timeoutMs })).rejects.toMatchObject({ code: 'EXPRESSION_LIMIT' })
  })
})
