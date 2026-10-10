import {createHash,randomUUID} from 'node:crypto'
import {readFileSync,statSync,mkdirSync,writeFileSync,renameSync,existsSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {manifestSchema,manifestPackage,type DynamicManifest} from './dynamic-schema.ts'
import {extensionApis} from './registry.ts'
import {installedExtensions} from './installed.ts'
export const assetPath='/app-card-extensions'
export const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const bounded=(p:string,max:number)=>{if(statSync(p).size>max)throw Error('Extension file too large');return readFileSync(p,'utf8')}
export interface InstalledDynamic {key:string;manifest:DynamicManifest}
export class DynamicExtensions{
 constructor(readonly root:string){}
 private text='';private current:InstalledDynamic[]=[]
 read():InstalledDynamic[]{
  const file=join(this.root,'active.json'),text=existsSync(file)?bounded(file,65536):'[]'
  if(text===this.text)return this.current
  const keys:unknown=JSON.parse(text)
  if(!Array.isArray(keys)||keys.length>32||keys.some(k=>typeof k!=='string'||!/^[a-f0-9]{64}$/.test(k))||new Set(keys).size!==keys.length)throw Error('Invalid extension registry')
  const next=keys.map(k=>this.load(k))
  extensionApis([...installedExtensions,...next.map(p=>manifestPackage(p.manifest))])
  this.current=next;this.text=text;return next
 }
 load(key:string):InstalledDynamic{
  if(!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid extension key')
  const raw=bounded(join(this.root,'packages',key,'manifest.json'),262144)
  if(hash(raw)!==key)throw Error('Extension manifest integrity mismatch')
  const manifest=manifestSchema.parse(JSON.parse(raw));manifestPackage(manifest)
  const code=bounded(join(this.root,'packages',key,'client.mjs'),4*1024*1024)
  if(hash(code)!==manifest.bundleSha256)throw Error('Extension bundle integrity mismatch')
  return {key,manifest}
 }
 packages(){return this.read().map(p=>manifestPackage(p.manifest))}
 descriptor(){const packages=this.read();return {generation:hash(JSON.stringify(packages.map(p=>p.key))),packages}}
 asset(key:string){this.load(key);return bounded(join(this.root,'packages',key,'client.mjs'),4*1024*1024)}
}
export function writeActive(root:string,keys:string[]){
 mkdirSync(root,{recursive:true,mode:0o700})
 const file=join(root,'active.json'),tmp=file+'.'+randomUUID()
 writeFileSync(tmp,JSON.stringify(keys)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,file)
}
export function stagePackage(root:string,dir:string){
 const m=manifestSchema.parse(JSON.parse(bounded(join(dir,'manifest.json'),262144)))
 manifestPackage(m)
 const code=bounded(join(dir,'client.mjs'),4*1024*1024)
 if(hash(code)!==m.bundleSha256)throw Error('Extension bundle integrity mismatch')
 const raw=JSON.stringify(m)+'\n',key=hash(raw),dest=join(root,'packages',key)
 mkdirSync(join(root,'packages'),{recursive:true,mode:0o700})
 if(!existsSync(dest)){
  const tmp=dest+'.'+randomUUID();mkdirSync(tmp,{mode:0o700})
  try{writeFileSync(join(tmp,'manifest.json'),raw,{mode:0o600});writeFileSync(join(tmp,'client.mjs'),code,{mode:0o600});renameSync(tmp,dest)}catch(e){rmSync(tmp,{recursive:true,force:true});throw e}
 }
 return new DynamicExtensions(root).load(key)
}
export function registerExtensionRoutes(ctx:any,store:DynamicExtensions){
 ctx.inject(['webServer','connection'],(web:any)=>{
  web.effect(()=>web.webServer.register({kind:'prefix',path:assetPath,handler:(req:any,res:any)=>{
   const admission=web.connection.admit(req)
   if('rejection' in admission){res.writeHead(admission.rejection);res.end('Access denied');return}
   if(req.method!=='GET'){res.writeHead(405);res.end();return}
   try{
    const path=new URL(req.url,'http://localhost').pathname
    if(path===assetPath+'/catalog.json'){
     res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(store.descriptor()));return
    }
    const match=new RegExp('^'+assetPath+'/([a-f0-9]{64})/client\\.mjs$').exec(path)
    if(!match){res.writeHead(404);res.end();return}
    const body=store.asset(match[1]);res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'});res.end(body)
   }catch(e){res.writeHead(503,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('Extension registry unavailable')}
  }}),'app-cards: extension assets')
 })
}
