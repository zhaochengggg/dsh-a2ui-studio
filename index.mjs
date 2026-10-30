import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import MachineManagement from './machines/index.mjs';
import {AppCardsService} from './apps/lib/index.js';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
export const inject=['tools','skills'];
export const Config=Schema.object({
  dataRoot:Schema.string(), machineRoot:Schema.string(), sshDir:Schema.string(),
  appCards:Schema.any(),
});
export function resolvePaths(config={}) {
  const home=resolve(config.dataRoot||process.env.DSH_HOME||join(homedir(),'.dsh'));
  return {machine:{root:config.machineRoot||join(home,'machines'),sshDir:config.sshDir||join(home,'machine-mgmt','ssh')},
    apps:{...config.appCards,dataPath:config.appCards?.dataPath||join(home,'app-cards')}};
}
export async function apply(ctx,config={}) {
  const paths=resolvePaths(config);
  ctx.plugin(MachineManagement,paths.machine);
  ctx.plugin(AppCardsService,paths.apps);
  const url=new URL('./skills/machine-management/SKILL.md',import.meta.url);
  const content=await readFile(url,'utf8');
  ctx.skills.register({name:'machine-management',description:'登记、连接和维护计算机目录；定位应用所属计算机。',content:content.replace(/^---[\s\S]*?---\s*/,''),source:'bundled',provider:'dsh-control-studio',path:fileURLToPath(url),resourceBase:{kind:'directory',path:fileURLToPath(new URL('./skills/machine-management/',import.meta.url))},invocation:{modelInvocable:true,userInvocable:true}});
}
