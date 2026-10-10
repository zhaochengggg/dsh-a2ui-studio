import {z} from 'zod/v3'
import {componentId,DataBindingSchema,DynamicValueSchema} from '@a2ui/web_core/v0_9'
import {extensionApis,type ExtensionPackage} from './registry.ts'
import {uiCall,uiCommon} from '../ui-functions.ts'
const key=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).refine(s=>!['constructor','prototype','__proto__','id','component'].includes(s))
const field=z.object({type:z.enum(['text','number','boolean','json','child','children']),optional:z.boolean().optional(),binding:z.boolean().optional(),enum:z.array(z.string()).min(1).max(100).optional(),min:z.number().finite().optional(),max:z.number().finite().optional()}).strict()
export const manifestSchema=z.object({format:z.literal(1),apiVersion:z.literal(1),id:z.string().regex(/^[a-z][a-z0-9-]*\.v[1-9][0-9]*$/),version:z.string().regex(/^\d+\.\d+\.\d+$/),description:z.string().max(2000),components:z.array(z.object({name:z.string(),properties:z.record(key,field)}).strict()).min(1).max(64),bundleSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
export type DynamicManifest=z.infer<typeof manifestSchema>
const json:z.ZodTypeAny=z.lazy(()=>z.union([z.null(),z.string(),z.number().finite(),z.boolean(),z.array(json),z.record(json)]))
const binding=DataBindingSchema.strict().extend({path:z.string().min(1).refine(p=>!/~(?![01])/.test(p)&&p.split('/').every(s=>!['__proto__','prototype','constructor','..','.'].includes(s.replace(/~1/g,'/').replace(/~0/g,'~'))))})
export function manifestPackage(input:unknown):ExtensionPackage{
 const m=manifestSchema.parse(input)
 const pack={id:m.id,version:m.version,description:m.description,components:m.components.map(c=>{
  const shape:Record<string,z.ZodTypeAny>={}
  for(const [name,f] of Object.entries(c.properties)){
   if(f.enum&&f.type!=='text')throw Error('enum requires text')
   if((f.min!==undefined||f.max!==undefined)&&f.type!=='number')throw Error('range requires number')
   if(f.min!==undefined&&f.max!==undefined&&f.min>f.max)throw Error('invalid number range')
   if(f.binding&&['child','children'].includes(f.type))throw Error('child bindings are not supported')
   let numeric=z.number().finite();if(f.min!==undefined)numeric=numeric.min(f.min);if(f.max!==undefined)numeric=numeric.max(f.max)
   let s:z.ZodTypeAny=f.type==='child'?componentId():f.type==='children'?z.array(componentId()):f.type==='text'?f.enum?z.enum(f.enum as [string,...string[]]):z.string():f.type==='boolean'?z.boolean():f.type==='number'?numeric:json
   if(f.binding)s=z.union([s,binding,uiCall]).describe(DynamicValueSchema.description??'')
   shape[name]=f.optional?s.optional():s
  }
  return {name:c.name,schema:z.object({...shape,...uiCommon}).strict()}
 })}
 extensionApis([pack]);return pack
}
let provider:()=>readonly ExtensionPackage[]=()=>[]
export function setDynamicProvider(next:()=>readonly ExtensionPackage[]){provider=next}
export function dynamicPackages(){return provider()}
