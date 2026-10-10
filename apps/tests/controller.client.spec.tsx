// @vitest-environment jsdom

import { StrictMode, useSyncExternalStore } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CardDeclaration, CardSnapshot, MachineId, RequestId, RunId, RunRecord } from '../src/types.ts'
import { AppCardsController, type AppCardsRemotePort } from '../src/client/controller.ts'
import { AppCards, type AppCardsProps } from '../src/client/AppCards.tsx'

const first = 'first' as MachineId
const second = 'second' as MachineId
const controllers: AppCardsController[] = []
afterEach(() => {
  cleanup()
  controllers.splice(0).forEach((controller) => { controller.dispose() })
  vi.useRealTimers()
})

function snapshot(machineId = first, revision = 1, sequence = 1): CardSnapshot {
  const declaration: CardDeclaration = {
    apiVersion: 'dsh.app-cards/v1', kind: 'MachineAppCards', machineId, revision,
    apps: { app: { name: 'App' } }, contexts: {}, data: {}, operations: {},
    actions: { run: { appId: 'app', label: 'Run', operation: 'run', input: { literal: {} },
      availability: { kind: 'always' }, invalidates: [] } },
    checks: {},
    ui: { a2uiVersion: '0.9.1', catalogId: 'urn:dsh:app-cards:catalog:1', surfaces: [{
      id: 'main', appId: 'app', order: 0, formInitial: {},
      components: [{ id: 'root', component: 'Text', text: `App on ${machineId}` }],
    }] },
  }
  return { machineId, revision, sequence, declaration, checks: {}, actions: { run: { enabled: true } }, runs: [] }
}

function run(): RunRecord {
  return {
    id: 'run' as RunId, machineId: first, revision: 1, requestId: 'request' as RequestId,
    kind: 'action', entryId: 'run', input: {}, createdAt: 1, state: 'queued',
  }
}

function setup() {
  const remote = {
    read: vi.fn((machineId: MachineId): Promise<RemoteResult<CardSnapshot>> =>
      Promise.resolve({ ok: true, value: snapshot(machineId) })),
    refresh: vi.fn<AppCardsRemotePort['refresh']>(() => Promise.resolve({ ok: true, value: [] })),
    invoke: vi.fn<AppCardsRemotePort['invoke']>(() => Promise.resolve({ ok: true, value: run() })),
    readRun: vi.fn<AppCardsRemotePort['readRun']>(() => Promise.resolve({ ok: true, value: run() })),
    cancel: vi.fn<AppCardsRemotePort['cancel']>(() => Promise.resolve({ ok: true, value: run() })),
  }
  const report = vi.fn()
  const controller = new AppCardsController(remote, report)
  controllers.push(controller)
  return { remote, report, controller }
}

function props(controller: AppCardsController, machineId = first, openKey = 1, refreshKey = 0): AppCardsProps {
  return {
    machineId, openKey, refreshKey,
    useAppCards: selector => useSyncExternalStore(controller.subscribe,
      () => selector(controller.getSnapshot())),
    openCards: controller.open, invokeCard: controller.invoke, cancelRun: controller.cancel,
    rereadCards: () => { controller.reread() },
    useSessions: selector => selector({
      phase: 'ready', ids: [], byId: {}, current: undefined,
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    }),
    useWorkspaces: vi.fn(),
    usePanelInfo: vi.fn(),
    useSessionPendingInteraction: vi.fn(),
    useResource: vi.fn(),
  }
}

describe('selected-machine application lifecycle', () => {
  it('checks exactly once per selected open/manual key, including StrictMode effects', async () => {
    const { controller, remote } = setup()
    const rendered = render(<StrictMode><AppCards {...props(controller)} /></StrictMode>)
    expect(await screen.findByText('App on first')).toBeTruthy()
    await waitFor(() => { expect(remote.refresh).toHaveBeenCalledTimes(1) })
    expect(remote.refresh).toHaveBeenCalledWith(first, 1, expect.any(String))
    rendered.rerender(<StrictMode><AppCards {...props(controller, first, 1, 1)} /></StrictMode>)
    await waitFor(() => { expect(remote.refresh).toHaveBeenCalledTimes(2) })
    rendered.rerender(<StrictMode><AppCards {...props(controller, second, 1, 1)} /></StrictMode>)
    await waitFor(() => { expect(remote.refresh).toHaveBeenCalledTimes(3) })
    expect(remote.refresh.mock.calls.map(call => call[0])).toEqual([first, first, second])
    rendered.unmount()
    controller.changed({ machineId: second, revision: 1, sequence: 1, kind: 'run' })
    expect(remote.refresh).toHaveBeenCalledTimes(3)
  })

  it('rereads on events and connection resets without check polling', async () => {
    vi.useFakeTimers()
    const { controller, remote } = setup()
    controller.open(first, 1, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(remote.refresh).toHaveBeenCalledOnce()
    const reads = remote.read.mock.calls.length
    controller.changed({ machineId: second, revision: 1, sequence: 1, kind: 'observation' })
    expect(remote.read).toHaveBeenCalledTimes(reads)
    controller.changed({ machineId: first, revision: 1, sequence: 1, kind: 'observation' })
    await vi.advanceTimersByTimeAsync(0)
    controller.reread()
    await vi.advanceTimersByTimeAsync(100_000)
    expect(remote.read).toHaveBeenCalledTimes(reads + 2)
    expect(remote.refresh).toHaveBeenCalledOnce()
  })

  it('discards old-machine reads and prevents their check admission', async () => {
    const { controller, remote } = setup()
    let resolve!: (value: RemoteResult<CardSnapshot>) => void
    remote.read.mockImplementationOnce(() => new Promise((accept) => { resolve = accept }))
    controller.open(first, 1, 0)
    controller.open(second, 1, 0)
    await waitFor(() => { expect(remote.refresh).toHaveBeenCalledOnce() })
    resolve({ ok: true, value: snapshot(first) })
    await act(async () => { await Promise.resolve() })
    expect(controller.getSnapshot().data?.machineId).toBe(second)
    expect(remote.refresh).toHaveBeenCalledWith(second, 1, expect.any(String))
  })

  it('hides old evidence when reads fail or lag behind an event', async () => {
    const { controller, remote, report } = setup()
    controller.open(first, 1, 0)
    await waitFor(() => { expect(remote.refresh).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(controller.getSnapshot().pending).toBe(false) })
    controller.changed({ machineId: first, revision: 2, sequence: 2, kind: 'declaration' })
    await waitFor(() => { expect(controller.getSnapshot().error).toContain('older') })
    expect(controller.getSnapshot().data).toBeNull()
    remote.read.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Disconnected', {}) })
    controller.reread()
    await waitFor(() => { expect(controller.getSnapshot().error).toContain('Disconnected') })
    expect(report).toHaveBeenCalledTimes(2)
    expect(remote.refresh).toHaveBeenCalledOnce()
  })

  it('uses one idempotency key for an invocation and exposes admission failures', async () => {
    const { controller, remote } = setup()
    controller.open(first, 1, 0)
    await waitFor(() => { expect(controller.getSnapshot().pending).toBe(false) })
    remote.invoke.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/bad-request', 'Refresh required', {}) })
    controller.invoke('run', { value: 1 })
    controller.invoke('run', { value: 1 })
    await waitFor(() => { expect(controller.getSnapshot().error).toContain('Refresh required') })
    expect(remote.invoke).toHaveBeenCalledOnce()
    expect(remote.invoke).toHaveBeenCalledWith(first, 1, 'run', { value: 1 }, expect.any(String))
    expect(controller.getSnapshot().data).toBeNull()
  })

  it('contains invalid declarations in the application region', async () => {
    const { controller, remote } = setup()
    const invalid = snapshot()
    remote.read.mockResolvedValue({ ok: true, value: {
      ...invalid, declaration: { ...invalid.declaration!,
        ui: { ...invalid.declaration!.ui, surfaces: [{ ...invalid.declaration!.ui.surfaces[0]!,
          components: [{ id: 'root', component: 'Unknown' }] }] } },
    } })
    render(<><p>Infrastructure remains visible</p><AppCards {...props(controller)} /></>)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Infrastructure remains visible')).toBeTruthy()
    expect(remote.refresh).not.toHaveBeenCalled()
  })
})
