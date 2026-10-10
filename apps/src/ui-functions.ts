/** Pure A2UI functions, shared validation and bounded expression syntax. */
import {z} from 'zod/v3'
import {DataBindingSchema,DynamicValueSchema,NotImplementation,AndImplementation,OrImplementation,EqualsImplementation,NotEqualsImplementation,GreaterThanImplementation,LessThanImplementation,ContainsImplementation,StartsWithImplementation,EndsWithImplementation,type FunctionImplementation} from '@a2ui/web_core/v0_9'
export const safePath=(p:string)=>p!==''&&!/~(?![01])/.test(p)&&p.split('/').every(s=>!['__proto__','prototype','constructor','.','..'].includes(s.replace(/~1/g,'/').replace(/~0/g,'~')))
export const uiPath=DataBindingSchema.strict().extend({path:z.string().refine(safePath,'Unsafe data path')})
export const uiCall=z.object({call:z.string().min(1),args:z.record(z.unknown()),returnType:z.enum(['string','number','boolean','array','object','any']).optional()}).strict()
export const uiBoolean=z.union([z.boolean(),uiPath,uiCall]).describe('REF:common_types.json#/$defs/DynamicBoolean')
export const uiNumber=z.union([z.number().finite(),z.null(),uiPath,uiCall]).describe('REF:common_types.json#/$defs/DynamicNumber')
export const uiText=z.union([z.string(),uiPath,uiCall]).describe('REF:common_types.json#/$defs/DynamicString')
const json:z.ZodTypeAny=z.lazy(()=>z.union([z.null(),z.string(),z.number().finite(),z.boolean(),z.array(json),z.record(json)]))
export const uiValue=z.union([uiPath,uiCall,json]).describe(DynamicValueSchema.description??'REF:common_types.json#/$defs/DynamicValue')
export const uiChecks=z.array(z.object({condition:uiBoolean,message:z.string().min(1).max(500)}).strict()).max(32)
export const uiCommon={visible:uiBoolean.optional(),disabled:uiBoolean.optional(),checks:uiChecks.optional()}
const any=z.unknown(), num=z.number().finite(), optionalNum=num.optional()
const fn=(name:string,returnType:FunctionImplementation['returnType'],shape:z.ZodRawShape,execute:(args:any)=>unknown,description:string):FunctionImplementation=>({name,returnType,schema:z.object(shape).strict(),execute,description})
const numeric=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)
const ops:[string,(a:number,b:number)=>number][]=[['add',(a,b)=>a+b],['subtract',(a,b)=>a-b],['multiply',(a,b)=>a*b],['divide',(a,b)=>a/b]]
export const uiFunctions:FunctionImplementation[]=[
 NotImplementation,AndImplementation,OrImplementation,EqualsImplementation,NotEqualsImplementation,GreaterThanImplementation,LessThanImplementation,ContainsImplementation,StartsWithImplementation,EndsWithImplementation,
 ...ops.map(([name,op])=>fn(name,'number',{a:any,b:any},({a,b})=>{if(!numeric(a)||!numeric(b))return null;const v=op(a,b);return Number.isFinite(v)?v:null},'Finite numeric arithmetic; missing values and division by zero return null.')),
 fn('choose','any',{condition:z.boolean(),then:any,else:any},a=>a.condition?a.then:a.else,'Choose a value without changing the underlying form fields.'),
 fn('coalesce','any',{values:z.array(any).max(64)},a=>a.values.find((v:any)=>v!==null&&v!==undefined)??null,'First non-null value; preserves false, zero and empty string.'),
 fn('required','boolean',{value:any},a=>a.value!==null&&a.value!==undefined&&a.value!==''&&(!Array.isArray(a.value)||a.value.length>0),'Require a non-empty value.'),
 fn('numeric','boolean',{value:any,min:optionalNum,max:optionalNum},a=>numeric(a.value)&&(a.min===undefined||a.value>=a.min)&&(a.max===undefined||a.value<=a.max),'Validate a finite number and optional inclusive bounds. Null is not zero.'),
 fn('length','boolean',{value:any,min:optionalNum,max:optionalNum},a=>(typeof a.value==='string'||Array.isArray(a.value))&&(a.min===undefined||a.value.length>=a.min)&&(a.max===undefined||a.value.length<=a.max),'Validate string/array length.'),
 fn('clamp','number',{value:any,min:num,max:num},a=>numeric(a.value)&&a.max>=a.min?Math.min(a.max,Math.max(a.min,a.value)):null,'Clamp a finite number; not a replacement for input validation.'),
 fn('formatNumber','string',{value:any,decimals:z.number().int().min(0).max(12).optional(),grouping:z.boolean().optional()},a=>numeric(a.value)?new Intl.NumberFormat('zh-CN',{minimumFractionDigits:a.decimals??0,maximumFractionDigits:a.decimals??2,useGrouping:a.grouping??true}).format(a.value):'—','Format a number; missing values show an em dash.'),
 fn('concat','string',{values:z.array(any).max(64)},a=>a.values.map((v:any)=>v==null?'':String(v)).join(''),'Join literals, paths or nested function results.'),
 fn('object','object',{keys:z.array(z.string().refine(k=>!['__proto__','prototype','constructor'].includes(k))).max(64),values:z.array(any).max(64)},a=>{if(a.keys.length!==a.values.length||new Set(a.keys).size!==a.keys.length)throw Error('object requires distinct keys and matching values');return Object.fromEntries(a.keys.map((k:string,i:number)=>[k,a.values[i]]))},'Construct an object from parallel keys and reactive values; useful for action input.'),
]
const byName=new Map(uiFunctions.map(f=>[f.name,f]))
/** Validate nested calls before admission, not only during rendering. */
export function validateUiExpressions(input:unknown){
 let count=0
 const scan=(v:any,depth:number):void=>{
  if(++count>8192||depth>32)throw Error('UI expression exceeds complexity limit')
  if(v===null||typeof v!=='object')return
  if(Array.isArray(v)){v.forEach(x=>scan(x,depth+1));return}
  for(const key of Object.keys(v))if(['__proto__','prototype','constructor'].includes(key))throw Error('Unsafe expression key')
  if('path' in v){if(typeof v.path!=='string'||!safePath(v.path))throw Error('Unsafe expression path')}
  if('call' in v){
   const call=uiCall.parse(v),f=byName.get(call.call);if(!f)throw Error('Unsupported UI function: '+call.call)
   if(call.returnType&&f.returnType!=='any'&&call.returnType!==f.returnType)throw Error('Function return type mismatch: '+call.call)
   let schema:any=f.schema;while(schema._def.typeName==='ZodEffects')schema=schema._def.schema
   const shape=schema.shape
   for(const k of Object.keys(call.args))if(!Object.hasOwn(shape,k))throw Error(`Unknown argument ${call.call}.${k}`)
   for(const [k,s] of Object.entries(shape) as [string,z.ZodTypeAny][]){
    if(!Object.hasOwn(call.args,k)&&!['ZodOptional','ZodDefault'].includes(s._def.typeName))throw Error(`Missing argument ${call.call}.${k}`)
    const arg=call.args[k];if(!hasDynamic(arg))s.parse(arg)
   }
  }
  Object.values(v).forEach(x=>scan(x,depth+1))
 }
 scan(input,0)
}
function hasDynamic(v:any,depth=0):boolean{if(depth>32)throw Error('UI expression exceeds complexity limit');return !!v&&typeof v==='object'&&(('path'in v)||('call'in v)||Object.values(v).some(x=>hasDynamic(x,depth+1)))}
