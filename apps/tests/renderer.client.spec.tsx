// @vitest-environment jsdom

import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenericBinder, getValue } from '@a2ui/web_core/v0_9'
import type { CardComponent, CardDeclaration, CardSnapshot, MachineId, RunId } from '../src/types.ts'
import { createAppCatalog, validateUi } from '../src/ui-catalog.ts'
import { AppCardRenderer, AppSurface, ResolvedSurface, type RendererHost } from '../src/client/renderer.tsx'

const renderers: AppCardRenderer[] = []
afterEach(() => {
  cleanup()
  for (const renderer of renderers.splice(0)) renderer.dispose()
  vi.useRealTimers()
})

function declaration(components?: readonly CardComponent[]): CardDeclaration {
  return {
    apiVersion: 'dsh.app-cards/v1', kind: 'MachineAppCards',
    machineId: 'test' as MachineId, revision: 1,
    apps: { app: { name: 'Test' } }, contexts: {}, operations: {},
    data: { title: 'Initial', items: [{ label: 'First' }, { label: 'Second' }] },
    actions: { save: { appId: 'app', label: 'Save', operation: 'save', input: { literal: {} },
      availability: { kind: 'always' }, invalidates: [] } },
    checks: { health: { appId: 'app', label: 'Health', operation: 'check', input: { literal: {} },
      evaluate: { language: 'jsonata', source: '{}' }, freshForMs: 1_000 } },
    ui: {
      a2uiVersion: '0.9.1', catalogId: 'urn:dsh:app-cards:catalog:1',
      surfaces: [{ id: 'main', appId: 'app', order: 0, formInitial: { name: 'Alice', accepted: false, choices: [] },
        components: components ?? [
          { id: 'root', component: 'Column', children: ['title', 'name', 'accepted', 'choices', 'save', 'list'] },
          { id: 'title', component: 'Text', text: { path: '/data/title' } },
          { id: 'name', component: 'TextField', label: 'Name', value: { path: '/form/name' } },
          { id: 'accepted', component: 'CheckBox', label: 'Accepted', value: { path: '/form/accepted' } },
          { id: 'choices', component: 'ChoicePicker', label: 'Choice', value: { path: '/form/choices' },
            options: [{ label: 'Option', value: 'one' }] },
          { id: 'save', component: 'Button', child: 'save-label',
            action: { event: { name: 'app.invoke', context: { actionId: 'save', input: { path: '/form' } } } } },
          { id: 'save-label', component: 'Text', text: 'Save' },
          { id: 'list', component: 'List', children: { componentId: 'item', path: '/data/items' } },
          { id: 'item', component: 'Text', text: { path: 'label' } },
        ] }],
    },
  }
}

function create(value = declaration(), onAction = vi.fn()) {
  const renderer = new AppCardRenderer(value, 'main', onAction)
  renderers.push(renderer)
  return renderer
}

function host(value: CardDeclaration): RendererHost {
  const snapshot: CardSnapshot = {
    machineId: value.machineId, revision: 1, sequence: 1, declaration: value,
    actions: { save: { enabled: true } }, runs: [],
    checks: { health: { checkId: 'health', revision: 1, runId: 'run' as RunId,
      observedAt: Date.now(), expiresAt: Date.now() + 1_000, health: 'healthy',
      summary: 'Host observation', value: {}, stale: false } },
  }
  return { snapshot, busy: false, invoke: vi.fn(), cancel: vi.fn() }
}

describe('official core React adapter', () => {
  it('binds DOM inputs, nested form action context, list templates, and data/component updates', async () => {
    const action = vi.fn()
    const binder = vi.spyOn(GenericBinder.prototype, 'subscribe')
    const renderer = create(declaration(), action)
    render(<ResolvedSurface renderer={renderer} />)
    expect(binder).toHaveBeenCalled()
    expect(screen.getByText('Initial')).toBeTruthy()
    expect(screen.getByText('First')).toBeTruthy()
    expect(screen.getByText('Second')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bob' } })
    fireEvent.click(screen.getByLabelText('Accepted'))
    fireEvent.click(screen.getByLabelText('Option'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await act(async () => { await Promise.resolve() })
    expect(action).toHaveBeenCalledWith(expect.objectContaining({
      name: 'app.invoke', surfaceId: 'main',
      context: { actionId: 'save', input: { name: 'Bob', accepted: true, choices: ['one'] } },
    }))
    act(() => { renderer.process([
      { version: 'v0.9.1', updateDataModel: { surfaceId: 'main', path: '/data/title', value: 'Updated' } },
      { version: 'v0.9.1', updateDataModel: { surfaceId: 'main', path: '/data/items', value: [{ label: 'Only' }] } },
      { version: 'v0.9.1', updateComponents: { surfaceId: 'main', components: [
        { id: 'save-label', component: 'Text', text: 'Apply' },
      ] } },
    ]) })
    expect(screen.getByText('Updated')).toBeTruthy()
    expect(screen.getByText('Only')).toBeTruthy()
    expect(screen.queryByText('Second')).toBeNull()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Bob')
    binder.mockRestore()
  })

  it('disposes tree subscriptions on delete and prevents use after disposal', () => {
    const renderer = create()
    const view = render(<ResolvedSurface renderer={renderer} />)
    const root = getValue(renderer.resolver.rootNode)!
    act(() => { renderer.process([{ version: 'v0.9.1', deleteSurface: { surfaceId: 'main' } }]) })
    expect(root.disposed).toBe(true)
    expect(renderer.resolver.activeNodeCount).toBe(0)
    expect(view.container.textContent).toBe('')
    renderer.dispose()
    expect(() =>{  renderer.process([]) }).toThrow('disposed')
  })

  it('renders all non-input catalog components without HTML or network interpretation', () => {
    const value = declaration([
      { id: 'root', component: 'Card', child: 'row' },
      { id: 'row', component: 'Row', children: ['tabs', 'disclosure', 'table', 'status', 'receipt', 'icon', 'divider'] },
      { id: 'tabs', component: 'Tabs', tabs: [{ title: 'One', child: 'one' }, { title: 'Two', child: 'two' }] },
      { id: 'one', component: 'Text', text: '<img src="https://example.invalid">', variant: 'h4' },
      { id: 'two', component: 'Text', text: 'Second panel' },
      { id: 'disclosure', component: 'Disclosure', title: 'Details', child: 'code' },
      { id: 'code', component: 'CodeBlock', text: '<script>alert(1)</script>' },
      { id: 'table', component: 'Table', columns: [{ title: 'Name', key: 'name' }], rows: [{ name: 'Table cell' }] },
      { id: 'status', component: 'Status', checkId: 'health' },
      { id: 'receipt', component: 'RunReceipt', actionId: 'save' },
      { id: 'icon', component: 'Icon', name: 'info' },
      { id: 'divider', component: 'Divider' },
    ])
    const rendered = render(<ResolvedSurface renderer={create(value)} host={host(value)} />)
    expect(rendered.container.querySelectorAll('img,script,iframe,link,style')).toHaveLength(0)
    expect(screen.getByText('Table cell')).toBeTruthy()
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Two' }))
    expect(screen.getByRole('tabpanel').textContent).toBe('Second panel')
    expect(createAppCatalog().functions.has('not')).toBe(true)
    expect(createAppCatalog().functions.has('choose')).toBe(true)
    expect(createAppCatalog().functions.has('object')).toBe(true)
    expect(createAppCatalog().functions.has('eval')).toBe(false)
    expect(createAppCatalog().components.size).toBe(25)
  })

  it('renders Host-only health and expires it locally without a remote request', async () => {
    vi.useFakeTimers()
    const value = declaration([{ id: 'root', component: 'Status', checkId: 'health' }])
    const facts = host(value)
    render(<ResolvedSurface renderer={create(value)} host={facts} />)
    expect(screen.getByRole('status').getAttribute('data-health')).toBe('healthy')
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(screen.getByRole('status').getAttribute('data-health')).toBe('unknown')
    expect(facts.invoke).not.toHaveBeenCalled()
  })

  it('mounts and disposes core instances under React StrictMode', async () => {
    const spy = vi.spyOn(AppCardRenderer.prototype, 'dispose')
    const value = declaration()
    const view = render(<StrictMode><AppSurface declaration={value} surfaceId="main" host={host(value)} /></StrictMode>)
    expect(await screen.findByText('Initial')).toBeTruthy()
    view.unmount()
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })
})

describe('shared UI admission', () => {
  it.each([
    [{ id: 'root', component: 'Unknown' }],
    [{ id: 'root', component: 'Column', children: ['missing'] }],
    [{ id: 'root', component: 'Card', child: 'root' }],
    [{ id: 'root', component: 'Text', text: 'x', style: { color: 'green' } }],
    [{ id: 'root', component: 'Text', text: { call: 'eval', args: { source: 'fetch("/")' } } }],
    [{ id: 'root', component: 'Text', text: { path: '/data/title', extra: true } }],
    [{ id: 'root', component: 'TextField', label: 'x', value: { path: '/data/title' } }],
    [{ id: 'root', component: 'TextField', label: 'x', value: { path: '/form/__proto__/x' } }],
    [{ id: 'root', component: 'Status', checkId: 'health', health: 'healthy' }],
    [{ id: 'root', component: 'RunReceipt', actionId: 'save', state: 'succeeded' }],
    [{ id: 'root', component: 'Text', text: 'a' }, { id: 'root', component: 'Text', text: 'b' }],
  ] satisfies CardComponent[][])('rejects invalid declarations before rendering: %j', (...components) => {
    expect(() =>{  validateUi(declaration(components)) }).toThrow()
  })

  it('rejects unknown envelope fields but accepts structured action input objects', () => {
    const value = declaration()
    expect(() =>{  validateUi({ ...value, ui: { ...value.ui, extra: true } } as CardDeclaration) }).toThrow()
    const surface = value.ui.surfaces[0]!
    const invalid = { ...value, ui: { ...value.ui, surfaces: [{ ...surface, extra: true }] } }
    expect(() => { validateUi(invalid) }).toThrow()
    const components = surface.components.map(component => component.id === 'save' ? {
      ...component, action: { event: { name: 'app.invoke', context: { actionId: 'save', input: { name: 'unbound' } } } },
    } : component)
    expect(() =>{  validateUi(declaration(components)) }).not.toThrow()
  })

  it('parses envelopes before MessageProcessor and rejects invalid graph updates without mutation', () => {
    const renderer = create()
    expect(() =>{  renderer.process([{ version: 'v0.9', deleteSurface: { surfaceId: 'main' } }]) }).toThrow('v0.9.1')
    expect(() =>{  renderer.process([{ version: 'v0.9.1', deleteSurface: { surfaceId: 'main' }, extra: 1 }]) }).toThrow()
    expect(() =>{  renderer.process([{ version: 'v0.9.1', updateComponents: { surfaceId: 'main', components: [
      { id: 'root', component: 'Card', child: 'absent' },
    ] } }]) }).toThrow('Unknown component reference')
    expect(getValue(renderer.resolver.rootNode)?.type).toBe('Column')
  })
})
