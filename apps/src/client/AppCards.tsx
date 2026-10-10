/** Isolated machine-detail application region using injected business state. @module */

import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import {previewSnapshot} from '../preview.ts'
import type {CardSnapshot} from '../types.ts'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { MachineDetailProps } from '../../../machines/contracts.ts'

import type { AppCardsController } from './controller.ts'
import { AppSurface, type RendererHost } from './renderer.tsx'
import css from './app-cards.module.css'
import {IconButton} from '../../../shared/ui.tsx'

/** Read model and commands supplied by the Client plugin, not discovered by React. */
export interface AppCardsInjected {
  readonly hooks: { readonly appCards: AppCardsController }
  readonly openCards: AppCardsController['open']
  readonly invokeCard: AppCardsController['invoke']
  readonly cancelRun: AppCardsController['cancel']
  readonly rereadCards: () => void
  readonly refreshCards: () => void
  readonly previewCard: (id: string) => Promise<CardSnapshot>
}

/** Props derived from the machine-owned slot and this plugin's injection. */
export type AppCardsProps = MachineDetailProps & InjectFace<AppCardsInjected>

/**
 * Render only the selected machine, with independent failures for each surface.
 * @param props - machine owner keys and injected app commands.
 * @returns application cards, a local loading/error state, or an empty region.
 */
export function AppCards(props: AppCardsProps): ReactNode {
  const state = props.useAppCards(value => value)
  const [preview,setPreview]=useState<CardSnapshot|null>(null)
  const [previewId,setPreviewId]=useState('')
  const [previewError,setPreviewError]=useState('')
  const [scenarioIndex,setScenarioIndex]=useState('')
  useEffect(()=>setScenarioIndex(''),[previewId,props.machineId])
  useEffect(()=>{setPreview(null);setPreviewId('');setPreviewError('')},[props.machineId])
  useEffect(()=>{
    if(!previewId){setPreview(null);return}
    let live=true
    void props.previewCard(previewId).then(value=>{if(live){setPreview(value);setPreviewError('')}}).catch(e=>{if(live)setPreviewError(String(e))})
    return ()=>{live=false}
  },[previewId,props.previewCard])
  useEffect(() => previewId ? undefined : props.openCards(props.machineId, props.openKey, props.refreshKey),
    [props.machineId, props.openKey, props.refreshKey, props.openCards,previewId])
  const data = state.machineId === props.machineId ? state.data : null
  const simulated=useMemo(()=>preview?.declaration?{...previewSnapshot(preview.declaration,scenarioIndex===''?undefined:preview.declaration.ui.previewScenarios?.[Number(scenarioIndex)]),extensionGeneration:preview.extensionGeneration}:null,[preview,scenarioIndex])
  const shown=simulated??data
  const declaration = shown?.declaration
  if (state.error && state.machineId === props.machineId) {
    return <section className={css.region} aria-label="应用与服务">
      <p role="alert" className={css.error}>{state.error}</p>
      <button type="button" onClick={props.rereadCards}>重新读取应用</button>
    </section>
  }
  if (!data) return <section className={css.region} aria-label="应用与服务"><p role="status">正在读取应用…</p></section>
  const host: RendererHost = { snapshot: shown!, busy: !!previewId || state.pending, invoke:previewId?()=>{}:props.invokeCard, cancel:previewId?()=>{}:props.cancelRun }
  return <section className={`${css.region} ${css.column}`} aria-label="应用与服务" data-machine-detail-card="apps">
    <header className={css.toolbar}><h4>应用卡片</h4><div className={css.row}>
      {data.drafts?.length?<select aria-label="卡片版本" value={previewId} onChange={e=>setPreviewId(e.currentTarget.value)}><option value="">已发布</option>{data.drafts.map(d=><option key={d.id} value={d.id}>草稿 v{d.revision} · {new Date(d.createdAt).toLocaleTimeString()}</option>)}</select>:null}
      <IconButton label="刷新应用状态" busy={state.pending} disabled={!!preview||!declaration} onClick={props.refreshCards}/>
    </div></header>
    {previewError?<p role="alert" className={css.error}>{previewError}</p>:null}
    {preview?<div className={css.notice}><strong>模拟预览 · 非真实观测，所有操作禁用</strong><label className={css.field}>预览场景<select aria-label="预览场景" value={scenarioIndex} onChange={e=>setScenarioIndex(e.currentTarget.value)}><option value="">无数据 / 空闲</option>{preview.declaration?.ui.previewScenarios?.map((s,i)=><option key={i} value={i}>{s.name}</option>)}</select></label></div>:null}
    {!declaration?<p className={css.secondary}>尚未纳管应用。告诉模型要监控或调节什么，它会按 app-cards-authoring skill 为你制作卡片。</p>:null}
    {declaration?.ui.surfaces.toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map(surface => <AppRegionBoundary key={`${declaration.revision}:${surface.id}`}>
        <AppSurface declaration={declaration} surfaceId={surface.id} host={host} />
      </AppRegionBoundary>)}
    </section>
}

/** Keep malformed data or renderer errors inside one app region. */
export class AppRegionBoundary extends Component<{ readonly children: ReactNode }, { readonly error: Error | null }> {
  override state = { error: null as Error | null }

  /** @param error - render failure. @returns local error state. */
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  /** @param error - isolated failure. @param info - React component location. */
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app-cards] region failed:', error, info.componentStack)
  }

  /** @returns children or a local, non-success error indicator. */
  override render(): ReactNode {
    return this.state.error
      ? <p role="alert" className={css.error}>应用暂不可用：{this.state.error.message}</p>
      : this.props.children
  }
}
