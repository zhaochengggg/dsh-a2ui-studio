/** Inert, explicit author fixtures. Never read by operation execution or live snapshots. */
import {z} from 'zod/v3'
import type {CardDeclaration,CardSnapshot,CheckObservation,RunRecord,JsonValue} from './types.ts'
const json:z.ZodTypeAny=z.lazy(()=>z.union([z.null(),z.string(),z.boolean(),z.number().finite(),z.array(json),z.record(z.string().refine(k=>!['__proto__','prototype','constructor'].includes(k)),json)]))
export const previewScenariosSchema=z.array(z.object({
 name:z.string().min(1).max(80),
 checks:z.record(z.object({value:json,health:z.enum(['healthy','unhealthy','unknown']),summary:z.string().max(2000),stale:z.boolean().optional()}).strict()),
 runs:z.array(z.object({actionId:z.string().min(1),state:z.enum(['queued','running','succeeded','failed','partial','cancelled','indeterminate','submitted','skipped']),value:json.optional()}).strict()).max(32).optional(),
}).strict()).max(8)
export type PreviewScenario=z.infer<typeof previewScenariosSchema>[number]
export function previewSnapshot(declaration:CardDeclaration,scenario?:PreviewScenario,now=Date.now()):CardSnapshot{
 if(scenario)previewScenariosSchema.parse([scenario])
 const checks:Record<string,CheckObservation>={}
 for(const [id,c] of Object.entries(scenario?.checks??{})){
  if(!declaration.checks[id])throw Error('Unknown preview check: '+id)
  checks[id]={checkId:id,revision:declaration.revision,runId:'preview' as any,observedAt:now,expiresAt:c.stale?now-1:now+86400000,health:c.health,summary:c.summary,value:c.value as JsonValue,stale:!!c.stale}
 }
 const runs:RunRecord[]=(scenario?.runs??[]).map((r,i)=>{
  if(!declaration.actions[r.actionId])throw Error('Unknown preview action: '+r.actionId)
  return {id:('preview-'+i) as any,requestId:'preview' as any,machineId:declaration.machineId,revision:declaration.revision,kind:'action',entryId:r.actionId,input:{},createdAt:now+i,state:r.state,...(!['queued','running'].includes(r.state)?{finishedAt:now+i,result:{state:r.state as any,value:r.value??null}}:{})}
 })
 return {machineId:declaration.machineId,revision:declaration.revision,sequence:0,declaration,checks,runs,actions:Object.fromEntries(Object.keys(declaration.actions).map(id=>[id,{enabled:false,reason:'模拟预览不执行操作'}]))}
}
