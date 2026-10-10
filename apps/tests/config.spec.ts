import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Config, resolveConfig } from '../src/config.ts'

describe('resolved application configuration', () => {
  it('shares all Loader defaults with direct construction and detaches mutable root lists', () => {
    const roots = [resolve('.')]
    const input = { dataPath: resolve('applications'), hostRoots: roots }
    const result = resolveConfig(input)
    expect(result).toEqual(Config(input))
    expect(result).toMatchObject({
      concurrency: 4, maxPendingRuns: 128, maxNotificationClients: 64,
      maxPendingNotificationFrames: 128, executionTimeoutMs: 60000, maxJsonBytes: 262144,
    })
    roots.push(resolve('other'))
    expect(result.hostRoots).toEqual([resolve('.')])
  })

  it('retains deployment overrides and requires explicit absolute execution roots', () => {
    const dataPath = resolve('applications')
    expect(resolveConfig({ dataPath, concurrency: 2, agentProvider: 'fixture', agentModel: 'fixture' }))
      .toMatchObject({ dataPath, concurrency: 2, agentProvider: 'fixture', agentModel: 'fixture' })
    expect(() => resolveConfig({ dataPath: 'relative' })).toThrow('absolute dataPath')
    expect(() => resolveConfig({ dataPath, hostRoots: ['relative'] })).toThrow('hostRoot')
    expect(() => resolveConfig({ dataPath, agentProvider: 'fixture' })).toThrow('together')
    expect(() => resolveConfig({ dataPath, concurrency: 0 })).toThrow()
  })
})
