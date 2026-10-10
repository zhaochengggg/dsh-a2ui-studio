/** Opt-in app-cards Client plugin; no execution is admitted during plugin load. @module */

import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

import appCardsRemote from '../remote.ts'
import {text as stylesheet} from './app-cards.module.css'
import { AppCards, type AppCardsInjected } from './AppCards.tsx'
import { AppCardsController } from './controller.ts'
import { startNotifications } from './notifications.ts'
import {loadDynamicExtensions} from '../extensions/dynamic-client.ts'

/** The injected Client session service, distinct from the Host's identically named registry. */
type ClientContext = Context & { sessions: ISessions }

/** Services needed by the generated Remote and root-scoped machine region. */
export const inject = ['remote', 'slots', 'sessions']

/**
 * Mount the generated Remote and contribute an additive machine-detail region.
 * @param ctx - browser Cordis context.
 * @returns Remote disposer; Cordis owns registrations and event listeners.
 */
export async function apply(ctx: ClientContext,mounted=false): Promise<() => Promise<void>> {
  await loadDynamicExtensions()
  const style=document.createElement('style');style.textContent=stylesheet;document.head.append(style)
  ctx.effect(()=>()=>style.remove(),'app-cards: stylesheet')
  const disposeRemote = mounted?async()=>{}:await ctx.remote.$mount(appCardsRemote)
  const remote = ctx.get('remote.appCards') as ClientRemote['appCards']
  const controller = new AppCardsController(remote, (error) => {
    console.error('[app-cards] request failed:', error)
  }, async (sessionId, text) => {
    await ctx.sessions.using(sessionId as SessionId,{source:'controllerOperation'},async ref=>{
      const binding=await ref.ready
      const result=await binding.session.prompt([{type:'text',text}],'queue')
      if(!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    })
  })
  try {
    ctx.effect(() => () => { controller.dispose() }, 'app-cards: dispose Client read model')
    const disposeNotifications = startNotifications(ctx.remote, {
      follow: streamSignal => remote.subscribe(streamSignal),
      reset: () => { controller.reread() },
      changed: (change) => { controller.changed(change) },
      failed: (error) => { controller.notificationFailed(error instanceof Error ? error : new Error(String(error))) },
    })
    ctx.effect(() => disposeNotifications, 'app-cards: notification stream')
    ctx.slots.inject('machine.detail.apps', () => ctx.slots.register({
      name: 'machine.detail.apps',
      id: 'app-cards',
      inject: (): AppCardsInjected => ({
        hooks: { appCards: controller },
        openCards: controller.open,
        invokeCard: controller.invoke,
        cancelRun: controller.cancel,
        rereadCards: () => { controller.reread() },
        refreshCards: controller.refresh,
        previewCard: async id => { const result=await remote.preview(id); if(!result.ok) throw new Error(result.error.message); return result.value },
      }),
    }, AppCards))
  } catch (error: unknown) {
    controller.dispose()
    await disposeRemote()
    throw error
  }
  return disposeRemote
}
