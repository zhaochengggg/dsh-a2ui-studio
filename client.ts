import {apply as machines} from './machines/client.jsx';
import {apply as apps} from './apps/src/client/index.ts';
import remote from './remote.ts';
import sharedStyles from './shared/ui.css';
export const inject=['remote','slots','sessions','conversation'];
export async function apply(ctx:any) {
  const style=document.createElement('style');style.textContent=sharedStyles;document.head.append(style);
  ctx.effect(()=>()=>style.remove(),'machine-apps: shared design system');
  const dispose=await ctx.remote.$mount(remote);
  await machines(ctx,true);
  // Machine registration stays usable if the application extension fails to initialize.
  try {await apps(ctx,true);} catch(error) {
    console.error('[machine-apps] application module failed',error);
    ctx.slots.inject('machine.detail.apps',()=>ctx.slots.register({name:'machine.detail.apps',id:'apps-error'},()=>String('应用模块暂不可用，请检查服务日志。')));
  }
  return dispose;
}
