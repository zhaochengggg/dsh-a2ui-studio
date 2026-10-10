import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppCardStore } from '../src/store.ts'
import { digest, executionDigest } from '../src/digest.ts'
import type { CardDeclaration, CardProposal, MachineId, ProposalId, RequestId } from '../src/types.ts'

const stores: AppCardStore[] = []
const directories: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const dataPath = await mkdtemp(join(tmpdir(), 'app-cards-store-'))
  directories.push(dataPath)
  const options = { dataPath, maxJsonBytes: 65536, historyLimit: 10, busyTimeoutMs: 1000 }
  const store = await AppCardStore.open(options)
  stores.push(store)
  return { store, options, dataPath }
}

function declaration(revision = 1): CardDeclaration {
  return {
    apiVersion: 'dsh.app-cards/v1', kind: 'MachineAppCards', machineId: 'test-machine' as MachineId, revision,
    apps: { web: { name: 'Web' } }, contexts: {}, data: {}, operations: {}, actions: {}, checks: {},
    ui: {
      a2uiVersion: '0.9.1', catalogId: 'urn:dsh:app-cards:catalog:1',
      surfaces: [{ id: 'web', appId: 'web', order: 0, formInitial: {}, components: [{ id: 'root', component: 'Text', text: 'Hello' }] }],
    },
  }
}

function proposal(document = declaration()): CardProposal {
  return {
    id: randomUUID() as ProposalId, declaration: document, expectedRevision: document.revision - 1,
    executionDigest: executionDigest(document, {}), documentDigest: digest(document),
    contexts: {}, askRef: 'user request', createdAt: Date.now(),
  }
}

const evidence = { questionId: 'review-1', sessionId: 'session-1', selected: '认可并发布', approvedAt: 1234 }

describe('application revision and authorization storage', () => {
  it('keeps proposals inert and restores the exact published version across reopen', async () => {
    const { store, options } = await fixture()
    const pending = proposal()
    await store.propose(pending)
    expect(await store.current(pending.declaration.machineId)).toBeNull()
    await store.publish(pending, evidence)
    expect((await store.current(pending.declaration.machineId))?.declaration).toEqual(pending.declaration)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = await AppCardStore.open(options)
    stores.push(reopened)
    expect((await reopened.current(pending.declaration.machineId))?.executionDigest).toBe(pending.executionDigest)
  })

  it('rejects a modified immutable declaration rather than executing an old cached copy', async () => {
    const { store, dataPath } = await fixture()
    const pending = proposal()
    await store.propose(pending)
    await store.publish(pending, evidence)
    const path = join(dataPath, 'machines', pending.declaration.machineId, 'revisions', `1-${pending.documentDigest}.json`)
    await writeFile(path, JSON.stringify({ ...pending.declaration, data: { modified: true } }))
    await expect(store.current(pending.declaration.machineId)).rejects.toMatchObject({ code: 'INTEGRITY' })
  })

  it('rejects tampered proposals and competing publishes without losing the winning revision', async () => {
    const { store, dataPath } = await fixture()
    const first = proposal()
    const second = proposal({ ...declaration(), data: { variant: 2 } })
    await store.propose(first)
    await store.propose(second)
    await store.publish(first, evidence)
    await expect(store.publish(second, evidence)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect((await store.current(first.declaration.machineId))?.declaration.data).toEqual({})
    const third = proposal(declaration(2))
    await store.propose(third)
    await writeFile(join(dataPath, 'proposals', `${third.id}.json`), JSON.stringify({ ...third, askRef: 'tampered' }))
    await expect(store.proposal(third.id)).rejects.toMatchObject({ code: 'INTEGRITY' })
  })

  it('deduplicates request ids and marks unfinished effects uncertain after restart', async () => {
    const { store, options } = await fixture()
    const pending = proposal()
    await store.propose(pending)
    await store.publish(pending, evidence)
    const request = {
      machineId: pending.declaration.machineId, revision: 1, requestId: randomUUID() as RequestId,
      kind: 'action' as const, entryId: 'start', input: {},
    }
    const first = store.admit(request)
    expect(store.admit(request)).toEqual({ run: first.run, fresh: false })
    expect(() => store.admit({ ...request, input: { different: true } })).toThrow('different content')
    store.start(first.run.id)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = await AppCardStore.open(options)
    stores.push(reopened)
    expect(reopened.run(first.run.id)).toMatchObject({ state: 'indeterminate', result: { error: { code: 'HOST_RESTARTED' } } })
    expect(reopened.admit(request).fresh).toBe(false)
  })

  it('withdraws a declaration without resetting the revision or accepting stale observations', async () => {
    const { store } = await fixture()
    const pending = proposal()
    await store.propose(pending)
    await store.publish(pending, evidence)
    store.remove(pending.declaration.machineId, 1)
    expect(await store.current(pending.declaration.machineId)).toBeNull()
    expect(store.head(pending.declaration.machineId).revision).toBe(2)
    expect(() => { store.remove(pending.declaration.machineId, 1) }).toThrow('changed before removal')
  })
})
