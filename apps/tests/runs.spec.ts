import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { executeOperation } from '../src/executor.ts'
import { AppCardRuns, type AuthorizedDeclaration } from '../src/runs.ts'
import { AppCardStore } from '../src/store.ts'
import type { MachineId, OperationResult, RequestId } from '../src/types.ts'

vi.mock('../src/executor.ts', () => ({ executeOperation: vi.fn() }))
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.resetAllMocks()
})

async function setup(concurrency = 2) {
  const root = await mkdtemp(join(tmpdir(), 'app-runs-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const config = resolveConfig({ dataPath: root, concurrency, maxPendingRuns: 3 })
  const store = await AppCardStore.open(config)
  const ctx = new Context()
  cleanup.push(async () => { store.close(); await ctx.fiber.dispose() })
  const owner = { changed: vi.fn(), current: vi.fn() }
  const runs = new AppCardRuns(ctx, store, config, owner)
  cleanup.push(() => runs.dispose())
  const current: AuthorizedDeclaration = {
    declaration: {
      apiVersion: 'dsh.app-cards/v1', kind: 'MachineAppCards', machineId: 'first' as MachineId,
      revision: 1, apps: {}, contexts: {}, data: {}, operations: {}, actions: {}, checks: {},
      ui: { a2uiVersion: '0.9.1', catalogId: 'urn:dsh:app-cards:catalog:1', surfaces: [] },
    }, contexts: {}, executionDigest: 'scheduler-test',
  }
  const admit = (machineId: string) => store.admit({
    machineId: machineId as MachineId, revision: 1, requestId: randomUUID() as RequestId,
    kind: 'action', entryId: 'say', input: {},
  }).run
  return { ctx, runs, store, owner, current, admit }
}

describe('receipt-owned execution scheduling', () => {
  it.each(['failed', 'cancelled', 'indeterminate'] as const)('keeps %s checks unknown without evaluating JSONata', async (state) => {
    const { runs, store, current } = await setup()
    const observed: AuthorizedDeclaration = {
      ...current,
      declaration: {
        ...current.declaration,
        checks: {
          health: {
            appId: 'demo', label: 'Readiness', operation: 'probe', input: { literal: {} }, freshForMs: 10000,
            evaluate: { language: 'jsonata', source: "$error('must not evaluate a non-successful run')" },
          },
        },
      },
    }
    vi.mocked(executeOperation).mockResolvedValue({
      state, value: '200', error: { code: 'OBSERVER_FAILED', message: 'No trustworthy observation' },
    })
    const observe = vi.spyOn(store, 'observe')
    const receipt = store.admit({
      machineId: current.declaration.machineId, revision: 1, requestId: randomUUID() as RequestId,
      kind: 'check', entryId: 'health', input: {},
    }).run
    runs.launch(receipt, observed, 'probe', false)
    await runs.task(receipt.id)
    expect(observe).toHaveBeenCalledWith(receipt.machineId, expect.objectContaining({
      health: 'unknown', error: 'No trustworthy observation', value: '200',
    }))
  })

  it('serializes same-machine actions while sharing capacity across other machines', async () => {
    const { runs, store, current, admit } = await setup()
    const gates = [0, 1, 2].map(() => Promise.withResolvers<OperationResult>())
    let at = 0
    vi.mocked(executeOperation).mockImplementation(async () => gates[at++]!.promise)
    const first = admit('first')
    const queued = admit('first')
    const other = admit('second')
    for (const run of [first, queued, other]) runs.launch(run, current, 'say', true)
    try {
      await vi.waitFor(() => { expect(executeOperation).toHaveBeenCalledTimes(2) })
      expect(store.run(first.id).state).toBe('running')
      expect(store.run(queued.id).state).toBe('queued')
      expect(store.run(other.id).state).toBe('running')
      expect(() => { runs.assertCapacity() }).toThrow('queue is full')
      gates[0]!.resolve({ state: 'succeeded', value: 'first' })
      await vi.waitFor(() => { expect(executeOperation).toHaveBeenCalledTimes(3) })
      expect(store.run(queued.id).state).toBe('running')
    } finally {
      for (const gate of gates) gate.resolve({ state: 'succeeded', value: null })
      await runs.dispose()
    }
    expect(store.run(first.id).result?.value).toBe('first')
    expect([queued, other].map(run => store.run(run.id).state)).toEqual(['succeeded', 'succeeded'])
    expect(() => { runs.assertCapacity() }).not.toThrow()
  })

  it('drains an aborted operation and records queued cancellation without executing it', async () => {
    const { runs, store, current, admit } = await setup(1)
    const stopped = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.mocked(executeOperation).mockImplementation(async (_declaration, _id, _input, environment) => {
      await new Promise<void>((resolve) => {
        environment.signal.addEventListener('abort', () => { stopped.resolve(undefined); resolve() }, { once: true })
      })
      await release.promise
      environment.signal.throwIfAborted()
      return { state: 'succeeded', value: null }
    })
    const first = admit('first')
    const queued = admit('first')
    runs.launch(first, current, 'say', true)
    runs.launch(queued, current, 'say', true)
    await vi.waitFor(() => { expect(executeOperation).toHaveBeenCalledOnce() })
    const done = vi.fn()
    const disposing = runs.dispose().then(done)
    try {
      await stopped.promise
      expect(done).not.toHaveBeenCalled()
    } finally {
      release.resolve(undefined)
      await disposing
    }
    expect(executeOperation).toHaveBeenCalledOnce()
    expect([first, queued].map(run => store.run(run.id).state)).toEqual(['cancelled', 'cancelled'])
    expect(runs.task(first.id)).toBeUndefined()
    expect(runs.task(queued.id)).toBeUndefined()
  })

  it('keeps failed result persistence visible to both receipt and machine reads', async () => {
    const { ctx, runs, store, current, admit, owner } = await setup()
    const report = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    vi.mocked(executeOperation).mockResolvedValue({ state: 'succeeded', value: 'completed externally' })
    const finish = vi.spyOn(store, 'finish').mockImplementationOnce(() => { throw new Error('disk unavailable') })
    const receipt = admit('first')
    try {
      runs.launch(receipt, current, 'say', true)
      await runs.task(receipt.id)
      expect(finish).toHaveBeenCalledOnce()
      expect(report).toHaveBeenCalledWith(expect.stringContaining('disk unavailable'))
      expect(() => runs.read(receipt.id)).toThrow('result persistence failed')
      expect(() => { runs.assertMachineReadable(receipt.machineId) }).toThrow('result persistence failed')
      expect(() => { runs.assertMachineReadable('other' as MachineId) }).not.toThrow()
      expect(owner.changed).toHaveBeenLastCalledWith(receipt.machineId, 'run')
    } finally {
      report.mockRestore()
      finish.mockRestore()
    }
  })
})
