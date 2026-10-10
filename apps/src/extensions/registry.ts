import type {ComponentApi} from '@a2ui/web_core/v0_9'
export interface ExtensionPackage {readonly id:string;readonly version:string;readonly description:string;readonly components:readonly ComponentApi[]}
export function extensionApis(packages:readonly ExtensionPackage[],reserved:readonly string[]=[]):ComponentApi[]{
  const seen=new Set(reserved),ids=new Set<string>();const result:ComponentApi[]=[]
  for(const p of packages){
    if(!/^[a-z][a-z0-9-]*\.v[1-9][0-9]*$/.test(p.id)||!/^\d+\.\d+\.\d+$/.test(p.version)||p.version.split('.')[0]!==p.id.split('.v')[1])throw Error('Invalid extension version: '+p.id)
    if(ids.has(p.id))throw Error('Duplicate extension: '+p.id);ids.add(p.id)
    for(const c of p.components){if(!c.name.startsWith(p.id+'.')||seen.has(c.name))throw Error('Invalid or duplicate extension component: '+c.name);seen.add(c.name);result.push(c)}
  }
  return result
}
