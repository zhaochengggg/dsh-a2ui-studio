import {ResolvedBinding,getValue,isComponentNode,type ComponentNode} from '@a2ui/web_core/v0_9'
const unwrap=(v:unknown)=>v instanceof ResolvedBinding?v.value:v
export function fieldErrors(type:string,value:(k:string)=>unknown,has:(k:string)=>boolean):string[]{
 const messages=value('validationErrors')
 const result=has('checks')&&value('isValid')!==true?(Array.isArray(messages)&&messages.length?[...messages] as string[]:['请检查输入']):[]
 if(type==='NumberField'||type==='Slider'){
  const v=value('value'),min=value('min'),max=value('max'),step=value('step')
  if(typeof v!=='number'||!Number.isFinite(v))result.push('请输入有效数字')
  for(const k of ['min','max','step'])if(has(k)&&(typeof value(k)!=='number'||!Number.isFinite(value(k) as number)))result.push('数值范围暂不可用')
  if(typeof min==='number'&&typeof max==='number'&&max<=min)result.push('数值范围无效')
  if(typeof v==='number'&&typeof min==='number'&&v<min)result.push(`不能小于 ${min}`)
  if(typeof v==='number'&&typeof max==='number'&&v>max)result.push(`不能大于 ${max}`)
  if(typeof step==='number'&&step<=0)result.push('步长必须大于 0')
  if(typeof v==='number'&&typeof step==='number'&&step>0){const q=(v-(typeof min==='number'?min:0))/step;if(Math.abs(q-Math.round(q))>1e-7)result.push(`请按 ${step} 的步长输入`)}
 }
 return [...new Set(result)]
}
/** Traverse resolved child nodes so hidden ancestors and repeated lists are respected. */
export function surfaceErrors(root:ComponentNode|null|undefined,has:(id:string,k:string)=>boolean):string[]{
 const seen=new Set<string>(),errors:string[]=[]
 const walk=(v:unknown):void=>{
  if(isComponentNode(v)){
   if(v.disposed||seen.has(v.instanceId))return;seen.add(v.instanceId)
   const props=getValue(v.props),value=(k:string)=>unwrap(props[k]),present=(k:string)=>has(v.componentId,k)
   if(present('visible')&&value('visible')!==true)return
   const disabled=present('disabled')&&value('disabled')!==false
   if(v.type!=='Button'&&!disabled)errors.push(...fieldErrors(v.type,value,present))
   Object.values(props).forEach(walk);return
  }
  if(Array.isArray(v)){v.forEach(walk);return}
  if(v&&typeof v==='object'&&!(v instanceof ResolvedBinding))Object.values(v).forEach(walk)
 }
 walk(root);return [...new Set(errors)]
}
