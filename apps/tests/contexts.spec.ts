import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveContexts } from '../src/contexts.ts'
import type { CardDeclaration, MachineId } from '../src/types.ts'
import type { MachineManagementService } from '../../machines/contracts.ts'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })

function document(cwd: string): CardDeclaration {
  return {
    apiVersion: 'dsh.app-cards/v1', kind: 'MachineAppCards', revision: 1, machineId: 'machine' as MachineId,
    apps: {}, contexts: { host: { kind: 'host', cwd } }, data: {}, actions: {}, checks: {}, operations: {},
    ui: { a2uiVersion: '0.9.1', catalogId: 'urn:dsh:app-cards:catalog:1', surfaces: [] },
  }
}
const machineMgmt: Pick<MachineManagementService, 'list' | 'inspect'> = {
  list: () => Promise.resolve({
    machines: [{
      id: 'machine' as MachineId, displayName: 'Machine', aliases: [], labels: {},
      strategy: 'libvirt', source: 'declared', reachability: 'unknown', stale: true, capabilities: [],
    }],
    diagnostics: [], git: { ok: false, message: 'Not needed for context tests' },
    runtime: {
      catalogPath: '/unused', journalPath: '/unused', journalMode: 'wal', journalSchemaVersion: 1,
      foreignKeys: true, observationTtlMs: 1000, clientPollIntervalMs: 1000, clientMaxPollsPerOpen: 1,
    },
  }),
  inspect: () => Promise.reject(new Error('A host-only application must not inspect SSH or libvirt')),
}

describe('application execution contexts', () => {
  it('denies local execution without an explicit deployment root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'app-context-'))
    directories.push(directory)
    await expect(resolveContexts(document(directory), machineMgmt, [], 10000))
      .rejects.toMatchObject({ code: 'HOST_CONTEXT_DISABLED' })
    const resolved = await resolveContexts(document(directory), machineMgmt, [directory], 10000)
    expect(resolved.host).toMatchObject({ kind: 'host', argvPrefix: [] })
    expect(resolved.host?.identity).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('does not turn a nonexistent machine or path into ambient SSH access', async () => {
    const candidate = document('/tmp')
    await expect(resolveContexts({ ...candidate, machineId: 'absent' as MachineId }, machineMgmt, ['/tmp'], 10000))
      .rejects.toMatchObject({ code: 'MACHINE_MISSING' })
    await expect(resolveContexts({ ...candidate, contexts: { ssh: { kind: 'ssh', pathId: 'missing', cwd: '/' } } },
      machineMgmt, [], 10000)).rejects.toThrow('must not inspect SSH')
  })
})
