/** React 18 adapter over the official A2UI processor, resolver, and binder. @module */

import {
  A2uiMessageSchema,
  MessageProcessor,
  NodeResolver,
  ResolvedBinding,
  WritableBinding,
  effect,
  computed,
  getValue,
  isComponentNode,
  peekValue,
  type A2uiClientAction,
  type ComponentApi,
  type ComponentNode,
  type NodeProps,
  type Signal,
} from '@a2ui/web_core/v0_9'
import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore,
  type ReactNode,
} from 'react'
import { z } from 'zod/v3'
import { createAppCatalog, parseUiJson, validateUi } from '../ui-catalog.ts'
import type { CardComponent, CardDeclaration, CardSnapshot, JsonValue, RunRecord } from '../types.ts'
import css from './app-cards.module.css'
import {scaleColor} from './color-scale.ts'
import {RangeGauge} from './range-gauge.tsx'
import {extensionViews,ExtensionBoundary} from '../extensions/client.tsx'
import {loadedGeneration} from '../extensions/dynamic-client.ts'
import {fieldErrors,surfaceErrors} from './form-validation.ts'

/** Host-owned facts and callbacks; declaration data cannot populate these fields. */
export interface RendererHost {
  readonly snapshot: CardSnapshot
  readonly busy: boolean
  readonly invoke: (actionId: string, input: JsonValue) => void
  readonly cancel: (runId: string) => void
}

const HostContext = createContext<RendererHost | null>(null)
const RendererContext = createContext<AppCardRenderer | null>(null)

/**
 * Own the core models and resolver subscriptions for one declared surface.
 * GenericBinder is constructed by NodeResolver, not duplicated by React components.
 */
export class AppCardRenderer {
  readonly processor: MessageProcessor<ComponentApi>
  readonly resolver: NodeResolver
  readonly formErrors: Signal<string[]>
  private declaration: CardDeclaration
  private disposed = false

  /**
   * @param declaration - complete Host-validated declaration.
   * @param surfaceId - selected declared surface.
   * @param onAction - receives resolved JSON actions; never evaluates agent source.
   */
  constructor(
    declaration: CardDeclaration, readonly surfaceId: string,
    onAction: (action: A2uiClientAction) => void, snapshot?: CardSnapshot,
  ) {
    if(snapshot?.extensionGeneration&&loadedGeneration&&snapshot.extensionGeneration!==loadedGeneration)throw Error('组件目录已更新，请刷新网页后继续使用')
    validateUi(declaration)
    this.declaration = declaration
    const surface = declaration.ui.surfaces.find(candidate => candidate.id === surfaceId)
    if (!surface) throw new Error(`Unknown surface: ${surfaceId}`)
    const catalog = createAppCatalog()
    this.processor = new MessageProcessor([catalog], onAction, { version: 'v0.9.1' })
    this.process([{
      version: 'v0.9.1',
      createSurface: { surfaceId, catalogId: catalog.id },
    }, {
      version: 'v0.9.1',
      updateDataModel: { surfaceId, value: {
        data: declaration.data, form: surface.formInitial, local: {},
        checks: snapshot?.checks ?? {}, actions: snapshot?.actions ?? {}, runs: snapshot?.runs ?? [],
      } },
    }, {
      version: 'v0.9.1',
      updateComponents: { surfaceId, components: surface.components },
    }])
    const model = this.processor.model.getSurface(surfaceId)
    if (!model) throw new Error(`A2UI did not create surface: ${surfaceId}`)
    this.resolver = new NodeResolver(model, catalog)
    this.formErrors=computed(()=>surfaceErrors(getValue(this.resolver.rootNode),(id,k)=>this.hasProperty(id,k)))
  }

  /**
   * Parse protocol envelopes and validate complete component graphs before core mutation.
   * @param values - v0.9.1 create/update/data/delete messages for this surface.
   * @throws for unknown fields, incompatible versions, or invalid component updates.
   */
  process(values: readonly unknown[]): void {
    if (this.disposed) throw new Error('App-card renderer is disposed')
    const messages = values.map(value => A2uiMessageSchema.parse(value))
    let declaration = this.declaration
    for (const message of messages) {
      if (message.version !== 'v0.9.1') throw new Error('App cards require A2UI v0.9.1')
      const payload = 'createSurface' in message ? message.createSurface
        : 'updateComponents' in message ? message.updateComponents
          : 'updateDataModel' in message ? message.updateDataModel : message.deleteSurface
      if (payload.surfaceId !== this.surfaceId) throw new Error(`Unexpected surface: ${payload.surfaceId}`)
      if ('createSurface' in message && (
        message.createSurface.catalogId !== declaration.ui.catalogId
        || message.createSurface.theme !== undefined
        || message.createSurface.sendDataModel === true
      )) throw new Error('App-card surface cannot supply a theme or export its data model')
      if ('updateDataModel' in message) parseUiJson(message.updateDataModel.value ?? null)
      if ('updateComponents' in message) {
        const incoming = message.updateComponents.components.map((component) => {
          const value = parseUiJson(component)
          if (typeof value !== 'object' || value === null || Array.isArray(value)
            || typeof value['id'] !== 'string' || typeof value['component'] !== 'string') {
            throw new Error('Component requires string id and component fields')
          }
          return value as CardComponent
        })
        declaration = {
          ...declaration,
          ui: {
            ...declaration.ui,
            surfaces: declaration.ui.surfaces.map(surface => surface.id !== this.surfaceId ? surface : {
              ...surface,
              components: [...new Map([...surface.components, ...incoming].map(entry => [entry.id, entry])).values()],
            }),
          },
        }
        validateUi(declaration)
      }
    }
    this.declaration = declaration
    this.processor.processMessages({ messages })
    if (messages.some(message => 'deleteSurface' in message)) this.resolver.dispose()
  }

  /** Dispose all core subscriptions and models; repeated calls are safe. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.resolver.dispose()
    this.processor.model.dispose()
  }

  /**
   * Read the declared action for one component in this surface.
   * @param componentId - local A2UI component identity.
   * @returns the immutable action entry identity.
   */
  actionId(componentId: string): string {
    const component = this.declaration.ui.surfaces.find(surface => surface.id === this.surfaceId)
      ?.components.find(candidate => candidate.id === componentId)
    if (!component || component.component !== 'Button') throw new Error(`Unknown button: ${componentId}`)
    return textValue(objectValue(objectValue(objectValue(component['action'])['event'])['context'])['actionId'])
  }
  observationIds(componentId:string):string[]{
    const component=this.declaration.ui.surfaces.find(s=>s.id===this.surfaceId)?.components.find(c=>c.id===componentId)
    const result=new Set<string>()
    const scan=(v:unknown):void=>{if(!v||typeof v!=='object')return;const p=(v as Record<string,unknown>).path;if(typeof p==='string'&&p.startsWith('/checks/'))result.add(p.split('/')[2]);for(const x of Object.values(v))scan(x)}
    scan(component);return [...result]
  }
  hasProperty(componentId:string,key:string):boolean{return Object.hasOwn(this.declaration.ui.surfaces.find(s=>s.id===this.surfaceId)?.components.find(c=>c.id===componentId)??{},key)}
}

/**
 * Render a declared surface with isolated core ownership and Host-only status.
 * @param props - immutable declaration, surface identity, and current Host facts.
 * @returns the component tree; errors propagate to the enclosing region boundary.
 */
export function AppSurface(props: {
  readonly declaration: CardDeclaration
  readonly surfaceId: string
  readonly host: RendererHost
}): ReactNode {
  const [renderer, setRenderer] = useState<AppCardRenderer | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const hostSnapshot = useRef(props.host.snapshot)
  hostSnapshot.current = props.host.snapshot
  const invoke = useRef(props.host.invoke)
  invoke.current=props.host.invoke
  const active=useRef<AppCardRenderer|null>(null)
  useEffect(() => {
    let instance: AppCardRenderer | undefined
    try {
      instance = new AppCardRenderer(props.declaration, props.surfaceId, (action) => {
        const context: Record<string, unknown> = action.context
        if (action.name !== 'app.invoke') throw new Error(`Unsupported action: ${action.name}`)
        invoke.current(textValue(context['actionId']), parseUiJson(context['input']))
      }, hostSnapshot.current)
      active.current=instance
      setError(null)
      setRenderer(instance)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause : new Error(String(cause)))
    }
    return () => { if(active.current===instance)active.current=null;instance?.dispose() }
  }, [props.declaration, props.surfaceId])
  useEffect(() => {
    if (renderer === null||renderer!==active.current) return
    try {
      if(props.host.snapshot.extensionGeneration&&loadedGeneration&&props.host.snapshot.extensionGeneration!==loadedGeneration)throw Error('组件目录已更新，请刷新网页后继续使用')
      renderer.process(['checks', 'actions', 'runs'].map(key => ({
        version: 'v0.9.1',
        updateDataModel: {
          surfaceId: props.surfaceId, path: `/${key}`,
          value: key === 'checks' ? props.host.snapshot.checks
            : key === 'actions' ? props.host.snapshot.actions : props.host.snapshot.runs,
        },
      })))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause : new Error(String(cause)))
    }
  }, [renderer, props.surfaceId, props.host.snapshot])
  if (error) throw error
  return <HostContext.Provider value={props.host}>
    {renderer === null ? null : <ResolvedSurface renderer={renderer} />}
  </HostContext.Provider>
}

/**
 * Render an existing core instance without taking ownership of it.
 * @param props - renderer and optional Host facts.
 * @returns reactive root tree, absent after surface deletion.
 */
export function ResolvedSurface({ renderer, host }: {
  readonly renderer: AppCardRenderer
  readonly host?: RendererHost
}): ReactNode {
  const node = useSignal(renderer.resolver.rootNode)
  const view = <RendererContext.Provider value={renderer}>
    {node?.disposed === false ? <NodeView node={node} /> : null}
  </RendererContext.Provider>
  return host ? <HostContext.Provider value={host}>{view}</HostContext.Provider> : view
}

function useSignal<T>(source: Signal<T>): T {
  const subscribe = useCallback((notify: () => void) => effect(() => {
    getValue(source)
    notify()
  }), [source])
  return useSyncExternalStore(subscribe, () => peekValue(source), () => peekValue(source))
}

function NodeView({ node }: { readonly node: ComponentNode }): ReactNode {
  const props = useSignal(node.props)
  const host = useContext(HostContext)
  const renderer = useContext(RendererContext)
  const id = useId()
  const [tab, setTab] = useState(0)
  const [,tick]=useState(0)
  const checks=host?(renderer?.observationIds(node.componentId)??[]).map(id=>host.snapshot.checks[id]):[]
  const expires=Math.min(...checks.filter(Boolean).map(c=>c!.expiresAt))
  useEffect(()=>{if(!Number.isFinite(expires)||expires<=Date.now())return;const t=setTimeout(()=>tick(n=>n+1),Math.min(2147483647,expires-Date.now()+1));return()=>clearTimeout(t)},[expires])
  const fresh=unwrap(props['fresh'])!==false&&checks.every(c=>c&&!c.stale&&!c.error&&c.expiresAt>Date.now()&&c.revision===host?.snapshot.revision)
  if (node.state !== 'resolved') throw new Error(`Unresolved component ${node.componentId}: ${node.state}`)
  const value = (key: string): unknown => unwrap(props[key])
  const has=(key:string)=>renderer?.hasProperty(node.componentId,key)??false
  const limit=(key:string,fallback:unknown)=>!has(key)?fallback:value(key)??null
  const label = textValue(value('label') ?? '')
  const accessibility = props['accessibility'] === undefined ? {} : objectValue(props['accessibility'])
  const ariaLabel = accessibility['label'] === undefined ? undefined : textValue(unwrap(accessibility['label']))
  const child = (item: unknown): ReactNode => {
    if (!isComponentNode(item)) throw new Error(`Invalid child in ${node.componentId}`)
    return <NodeView key={item.instanceId} node={item} />
  }
  const children = (): ReactNode[] => arrayValue(props['children']).map(child)
  const write = (next: JsonValue): void => {
    const binding = props['value']
    if (!(binding instanceof WritableBinding) || !/^\/(?:form|local)(?:\/|$)/u.test(binding.path)) {
      throw new Error(`Input ${node.componentId} has no writable form binding`)
    }
    binding.set(next)
  }
  const readOnly = !(props['value'] instanceof WritableBinding)
  const disabled=has('disabled')&&value('disabled')!==false
  const errors=disabled?[]:fieldErrors(node.type,value,has)
  const errorHint=errors.length?<span id={`${id}-errors`} className={css.error} role="status">{errors.join('；')}</span>:null
  const inputA11y={'aria-label':ariaLabel??label,'aria-invalid':errors.length>0,'aria-describedby':errors.length?`${id}-errors`:undefined}
  if(has('visible')&&value('visible')!==true) return null
  const extension=extensionViews[node.type]
  if(extension){const View=extension;return <ExtensionBoundary key={node.type+node.componentId}><fieldset className={css.extensionFieldset} disabled={disabled}><View value={value} has={has} raw={props} child={child} fresh={fresh} ariaLabel={ariaLabel}/>{errorHint}</fieldset></ExtensionBoundary>}
  const color=fresh&&value('colorScale')?scaleColor(limit('colorValue',value('value')),limit('colorMin',limit('min',0)),limit('colorMax',limit('max',100)),value('colorScale')==='reverse-thermal'):undefined
  switch (node.type) {
    case 'Grid':
      return <div className={css.grid} style={{'--ac-columns':value('columns')??2} as React.CSSProperties} aria-label={ariaLabel}>{children()}</div>
    case 'Row':
    case 'Column':
      return <div className={node.type === 'Row' ? css.row : css.column}
        aria-label={ariaLabel} data-align={value('align')} data-justify={value('justify')}>{children()}</div>
    case 'Card':
      return <section className={css.card} data-warning={fresh&&value('warning')===true} data-quality={fresh?'current':'stale'} style={color?{'--ac-signal':color,backgroundColor:`color-mix(in srgb, ${color} 12%, var(--dsw-alias-bg-base))`} as React.CSSProperties:undefined} aria-label={ariaLabel}>{child(props['child'])}{fresh&&value('warning')===true&&value('warningText')?<p role="status" className={css.warningText}>{String(value('warningText'))}</p>:null}{!fresh&&<span className={css.secondary}>状态已过期或未知</span>}</section>
    case 'List': {
      const items = children().map((item, index) => <li key={index}>{item}</li>)
      return value('listStyle') === 'ordered'
        ? <ol className={css.list} data-direction={value('direction')} aria-label={ariaLabel}>{items}</ol>
        : <ul className={css.list} data-direction={value('direction')} data-list-style={value('listStyle')}
          aria-label={ariaLabel}>{items}</ul>
    }
    case 'Tabs': {
      const tabs = arrayValue(props['tabs']).map(objectValue)
      const selected = Math.min(tab, tabs.length - 1)
      return <div className={css.column}>
        <div role="tablist" aria-label={ariaLabel ?? '应用标签页'} className={css.row}>
          {tabs.map((item, index) => <button key={index} type="button" role="tab"
            id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-selected={index === selected}
            onClick={() => { setTab(index) }}>{textValue(unwrap(item['title']))}</button>)}
        </div>
        {tabs.map((item, index) => <div key={index} role="tabpanel" id={`${id}-panel-${index}`}
          aria-labelledby={`${id}-tab-${index}`} hidden={index !== selected}>{child(item['child'])}</div>)}
      </div>
    }
    case 'Disclosure':
      return <details className={css.card}><summary>{textValue(value('title'))}</summary>{child(props['child'])}</details>
    case 'Text': {
      const Tag = z.enum(['h1', 'h2', 'h3', 'h4', 'h5', 'caption', 'body']).parse(value('variant') ?? 'body')
      const content = textValue(value('text') ?? '')
      return Tag === 'body' || Tag === 'caption'
        ? <span className={Tag === 'caption' ? css.secondary : undefined}>{content}</span>
        : <Tag>{content}</Tag>
    }
    case 'Icon':
      return <svg role="img" aria-label={ariaLabel ?? textValue(value('name'))} className={css.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d={({info:'M12 11v6m0-10v1M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',check:'m5 12 4 4L19 6',warning:'M12 8v5m0 3v1M12 2 1 21h22Z',error:'m7 7 10 10M17 7 7 17',play:'m7 3 14 9-14 9Z',stop:'M5 5h14v14H5Z',refresh:'M20 7V2m0 5h-5M4 17v5m0-5h5M4 9a8 8 0 0 1 14-4l2 2M20 15A8 8 0 0 1 6 19l-2-2'})[textValue(value('name'))]} />
      </svg>
    case 'Divider':
      return <hr className={css.divider} aria-orientation={value('axis') === 'vertical' ? 'vertical' : 'horizontal'} />
    case 'CodeBlock':
      return <pre className={css.code}><code>{textValue(value('text') ?? '')}</code></pre>
    case 'Metric':
      return <div className={css.metric} data-quality={fresh?'current':'stale'}><span className={css.secondary}>{label}</span><strong style={{color}}>{value('value')==null?'—':displayJson(value('value'))}<small>{textValue(value('unit')??'')}</small></strong>{!fresh?<span className={css.secondary}>已过期</span>:value('hint')?<span className={css.secondary}>{textValue(value('hint'))}</span>:null}</div>
    case 'Progress': {
      return <RangeGauge role="progressbar" compact={value('variant')!=='detailed'} label={label} value={value('value')} min={limit('min',0)} max={limit('max',100)} marker={value('marker')} unit={String(value('unit')??'')} fresh={fresh} colorScale={value('colorScale')} colorValue={limit('colorValue',undefined)} colorMin={limit('colorMin',undefined)} colorMax={limit('colorMax',undefined)} ariaLabel={ariaLabel}/>
    }
    case 'Sparkline': {
      const values=z.array(z.number().finite()).max(512).parse(value('values')??[])
      const min=Math.min(...values),max=Math.max(...values),range=max-min||1
      const points=values.map((v,i)=>`${4+i*292/Math.max(1,values.length-1)},${56-(v-min)*48/range}`).join(' ')
      return <figure className={css.sparkline} data-quality={!fresh?'stale':values.length?'current':'unknown'}><figcaption>{label}<span>{values.length?`${values.at(-1)} ${value('unit')??''}`:'暂无观测'}{!fresh?' · 已过期':''}</span></figcaption><svg viewBox="0 0 300 64" role="img" aria-label={`${ariaLabel??label}，${values.length} 个采样点${!fresh?'，观测已过期':''}`}><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg></figure>
    }
    case 'NumberField':
    case 'Slider': {
      const v=value('value')
      return <label className={css.field}>{label}<div className={css.row}><input {...inputA11y} type={node.type==='Slider'?'range':'number'} min={typeof value('min')==='number'?value('min') as number:undefined} max={typeof value('max')==='number'?value('max') as number:undefined} step={value('step') as number??'any'} value={typeof v==='number'?v:''} disabled={readOnly||disabled||(node.type==='Slider'&&errors.some(e=>e.includes('范围')))} onChange={event=>{const next=event.currentTarget.valueAsNumber;write(Number.isFinite(next)?next:null)}}/>{node.type==='Slider'?<output>{typeof v==='number'?v:'—'} {value('unit') as string??''}</output>:value('unit')?<span>{String(value('unit'))}</span>:null}</div>{errorHint}</label>
    }
    case 'Link': {
      const url=textValue(value('url')??'')
      let safe=false
      try {safe=['http:','https:'].includes(new URL(url).protocol)} catch {}
      return safe?<a className={css.link} href={url} target="_blank" rel="noopener noreferrer">{label} ↗</a>:<span className={css.secondary}>{label}（地址不可用）</span>
    }
    case 'Table': {
      const columns = arrayValue(props['columns']).map(objectValue)
      const rows = arrayValue(value('rows')??[]).map(objectValue)
      return <div className={css.table}><table aria-label={ariaLabel}><thead><tr>
        {columns.map((column, index) => <th key={index}>{textValue(unwrap(column['title']))}</th>)}
      </tr></thead><tbody>{rows.map((row, index) => <tr key={index}>
        {columns.map((column, columnIndex) => <td key={columnIndex}>
          {displayJson(row[textValue(column['key'])])}
        </td>)}
      </tr>)}</tbody></table></div>
    }
    case 'TextField':
      return <label className={css.field}>{label}
        {value('variant') === 'longText'
          ? <textarea {...inputA11y} value={textValue(value('value') ?? '')} readOnly={readOnly} disabled={disabled}
            onChange={(event) => { write(event.currentTarget.value) }} />
          : <input {...inputA11y} disabled={disabled} type={value('variant') === 'obscured' ? 'password' : value('variant') === 'number' ? 'number' : 'text'}
            value={textValue(value('value') ?? '')} readOnly={readOnly}
            onChange={(event) => { write(event.currentTarget.value) }} />}
      {errorHint}</label>
    case 'CheckBox':
      return <div className={css.field}><label className={css.choice}><input {...inputA11y} type="checkbox" checked={z.boolean().parse(value('value') ?? false)}
        disabled={readOnly||disabled} onChange={(event) => { write(event.currentTarget.checked) }} /><span>{label}</span></label>{errorHint}</div>
    case 'ChoicePicker': {
      const selected = z.array(z.string()).parse(value('value') ?? [])
      const multiple = value('variant') === 'multipleSelection'
      return <fieldset className={css.column} disabled={disabled} aria-invalid={errors.length>0}><legend>{label}</legend>
        {arrayValue(props['options']).map(objectValue).map((option, index) => {
          const optionValue = textValue(option['value'])
          return <label key={index} className={css.choice}>
            <input type={multiple ? 'checkbox' : 'radio'} name={id} disabled={readOnly}
              checked={selected.includes(optionValue)}
              onChange={(event) => { write(multiple
                ? event.currentTarget.checked ? [...selected, optionValue] : selected.filter(item => item !== optionValue)
                : [optionValue]) }} />
            <span>{textValue(unwrap(option['label']))}</span>
          </label>
        })}
      {errorHint}</fieldset>
    }
    case 'Button': {
      const actionId = renderer?.actionId(node.componentId)
      const availability = actionId === undefined ? undefined : host?.snapshot.actions[actionId]
      const blocked = disabled||errors.length>0||(host !== null && (host.busy || availability?.enabled !== true))
      return <ValidatedButton renderer={renderer!} validateForm={value('validateForm')!==false} variant={value('variant')} disabled={blocked} reason={errors[0]??availability?.reason} onClick={() => {
          const invoke = props['action']
          if (typeof invoke !== 'function') throw new Error(`Invalid action in ${node.componentId}`)
          const callback = invoke as () => void
          const confirm=value('confirm')
          if(typeof confirm==='string' && !window.confirm(confirm)) return
          callback()
        }}>{child(props['child'])}</ValidatedButton>
    }
    case 'Status':
      return host ? <HostStatus host={host} checkId={textValue(value('checkId'))} compact={value('variant')!=='detailed'} /> : <span>未知</span>
    case 'RunReceipt':
      return host ? <HostReceipt host={host} actionIds={value('actionIds') as string[]??[textValue(value('actionId'))]} hideEmpty={value('empty')!=='label'} /> : value('empty')!=='label'?null:<span>暂无运行</span>
    default:
      throw new Error(`Unknown renderer: ${node.type}`)
  }
}

function ValidatedButton({renderer,validateForm,disabled,variant,reason,onClick,children}:{renderer:AppCardRenderer;validateForm:boolean;disabled:boolean;variant:unknown;reason?:string;onClick:()=>void;children:ReactNode}){
 const errors=useSignal(renderer.formErrors),blocked=disabled||(validateForm&&errors.length>0)
 return <button type="button" className={css.button} data-variant={variant} disabled={blocked} title={reason??(validateForm?errors[0]:undefined)} onClick={()=>{if(disabled||(validateForm&&peekValue(renderer.formErrors).length))return;onClick()}}>{children}</button>
}

function HostStatus({ host, checkId, compact=false }: { readonly host: RendererHost; readonly checkId: string; readonly compact?:boolean }): ReactNode {
  const check = host.snapshot.checks[checkId]
  const [, invalidate] = useState(0)
  useEffect(() => {
    if (!check || check.expiresAt <= Date.now()) return
    const timeout = setTimeout(() => { invalidate(value => value + 1) }, Math.min(check.expiresAt - Date.now(), 2_147_483_647))
    return () => { clearTimeout(timeout) }
  }, [check])
  const stale = !check || check.stale || check.revision !== host.snapshot.revision || check.expiresAt <= Date.now()
  const health = stale || check.error ? 'unknown' : check.health
  const title=stale?'证据已过期或未知':{healthy:'健康',unhealthy:'异常',unknown:'未知'}[health]
  if(compact)return <details role="status" className={css.statusCompact} data-health={health}><summary title={check?`${check.error??check.summary} · 观测于 ${new Date(check.observedAt).toLocaleString()}`:'暂无观测'}><span className={css.statusDot}/>{title}</summary><div className={css.status}>{check?<><span>{check.error??check.summary}</span><time dateTime={new Date(check.observedAt).toISOString()}>观测于 {new Date(check.observedAt).toLocaleString()}</time></>:<span>暂无观测</span>}</div></details>
  return <div role="status" className={css.status} data-health={health}>
    <strong>{stale ? '证据已过期或未知' : { healthy: '健康', unhealthy: '异常', unknown: '未知' }[health]}</strong>
    {check ? <span>{check.error ?? check.summary}</span> : <span>暂无观测</span>}
    {check ? <time className={css.secondary} dateTime={new Date(check.observedAt).toISOString()}>
      观测于 {new Date(check.observedAt).toLocaleString()}
    </time> : null}
  </div>
}

function HostReceipt({ host, actionIds, hideEmpty=false }: { readonly host: RendererHost; readonly actionIds: readonly string[]; readonly hideEmpty?:boolean }): ReactNode {
  const run = host.snapshot.runs.filter(candidate => candidate.kind === 'action'
    && actionIds.includes(candidate.entryId) && candidate.revision === host.snapshot.revision).sort((a,b)=>b.createdAt-a.createdAt)[0]
  if (!run) return hideEmpty?null:<span className={css.secondary}>暂无运行</span>
  return <details className={css.receipt}>
    <summary>{{
      queued: '等待执行', running: '执行中', succeeded: '执行完成', failed: '执行失败',
      partial: '部分完成', cancelled: '已取消', indeterminate: '结果不确定', submitted: '已交给 agent', skipped: '已跳过',
    }[run.state]}{actionIds.length>1?` · ${host.snapshot.declaration?.actions[run.entryId]?.label??run.entryId}`:''}</summary>
    <pre className={css.code}>{JSON.stringify(receiptFacts(run), null, 2)}</pre>
    {run.state === 'queued' || run.state === 'running'
      ? <button type="button" disabled={host.busy} onClick={() => { if(!host.busy)host.cancel(run.id) }}>取消运行</button> : null}
  </details>
}

function receiptFacts(run: RunRecord): unknown {
  return { id: run.id, createdAt: run.createdAt, finishedAt: run.finishedAt, result: run.result, submission: run.submission }
}

function unwrap(value: unknown): unknown {
  return value instanceof ResolvedBinding ? value.value : value
}

function textValue(value: unknown): string {
  return z.string().parse(value)
}

function arrayValue(value: unknown): unknown[] {
  return z.array(z.unknown()).parse(value)
}

function objectValue(value: unknown): NodeProps {
  return z.record(z.unknown()).parse(value)
}

function displayJson(value: unknown): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(parseUiJson(value))
}
