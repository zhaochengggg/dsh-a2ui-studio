import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import {manifestSchema,manifestPackage,setDynamicProvider} from './dynamic-schema.ts'
import {extensionApis} from './registry.ts'
import {installedExtensions} from './installed.ts'
import {extensionViews} from './client.tsx'
import {RangeGauge} from '../client/range-gauge.tsx'
import {scaleColor,ratio} from '../client/color-scale.ts'
export let loadedGeneration:string|undefined
export const extensionFailures:Record<string,string>={}
const prefix='/app-card-extensions'
/** Trusted, locally installed ESM only. Never evaluate declaration-provided code or URLs. */
export async function loadDynamicExtensions(fetcher:typeof fetch=fetch,importer:(url:string)=>Promise<any>=url=>import(/* @vite-ignore */ url)){
 const response=await fetcher(prefix+'/catalog.json',{credentials:'same-origin',cache:'no-store'})
 if(!response.ok)throw Error(`扩展目录读取失败 (${response.status})，请刷新重试`)
 const data=await response.json()
 if(!data||!/^[a-f0-9]{64}$/.test(data.generation)||!Array.isArray(data.packages)||data.packages.length>32)throw Error('Invalid extension catalog')
 const entries=data.packages.map((p:any)=>{if(!/^[a-f0-9]{64}$/.test(p.key))throw Error('Invalid extension key');return {key:p.key,manifest:manifestSchema.parse(p.manifest)}})
 const packages=entries.map((p:any)=>manifestPackage(p.manifest))
 extensionApis([...installedExtensions,...packages])
 // Commit schemas only once; a browser refresh gives a new, consistent generation.
 const views:Record<string,any>={}
 for(const entry of entries){
  try{
   const mod=await importer(`${prefix}/${entry.key}/client.mjs`)
   if(mod.apiVersion!==1)throw Error('Unsupported component runtime API')
   const result=mod.createComponents({React,jsxRuntime,sdk:{RangeGauge,scaleColor,ratio}})
   const expected=entry.manifest.components.map((c:any)=>c.name)
   if(!result||Object.keys(result).length!==expected.length||expected.some((n:string)=>typeof result[n]!=='function'))throw Error('Component exports do not match manifest')
   Object.assign(views,result)
  }catch(e){
   extensionFailures[entry.manifest.id]=String(e)
   for(const c of entry.manifest.components)views[c.name]=()=>React.createElement('span',{role:'alert'},'组件加载失败，请刷新重试')
   console.error('[app-cards] extension load failed',entry.manifest.id,e)
  }
 }
 Object.assign(extensionViews,views);setDynamicProvider(()=>packages);loadedGeneration=data.generation
}
