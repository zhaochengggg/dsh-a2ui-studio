import {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdirSync,readdirSync,rmSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {homedir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {DynamicExtensions,stagePackage,writeActive,hash} from './dynamic-host.ts'
import {setDynamicProvider,manifestSchema,manifestPackage} from './dynamic-schema.ts'
import {installedExtensions} from './installed.ts'
import {extensionApis} from './registry.ts'
import {parseDeclaration} from '../declaration.ts'
import {validateUi} from '../ui-catalog.ts'
const args=process.argv.slice(2)
let dataPath=join(process.env.DSH_HOME??join(homedir(),'.dsh'),'app-cards')
const pi=args.indexOf('--data-path');if(pi>=0){if(!args[pi+1])throw Error('Missing data path');dataPath=resolve(args[pi+1]);args.splice(pi,2)}
const [command,input,output]=args,root=join(dataPath,'extensions'),store=new DynamicExtensions(root)
function validateCurrent(){
 const file=join(dataPath,'state.sqlite3');if(!existsSync(file))return 0
 const db=new DatabaseSync(file,{readOnly:true});let count=0
 try{for(const r of db.prepare('SELECT id,revision,document_digest FROM machines WHERE deleted=0').all()){
  const path=join(dataPath,'machines',String(r.id),'revisions',`${r.revision}-${r.document_digest}.json`)
  const doc=parseDeclaration(JSON.parse(readFileSync(path,'utf8')));validateUi(doc);count++
 }}finally{db.close()}
 return count
}
async function main(){
 if(command==='build'){
  if(!input||!output)throw Error('build SOURCE_DIR OUTPUT_DIR')
  const source=resolve(input),dest=resolve(output)
  const raw=JSON.parse(readFileSync(join(source,'extension.json'),'utf8'))
  const spec=manifestSchema.parse({...raw,bundleSha256:'0'.repeat(64)});manifestPackage(spec)
  const require=createRequire(import.meta.url)
  const {build}=require('esbuild')
  const result=await build({entryPoints:[join(source,'client.tsx')],bundle:true,write:false,format:'cjs',platform:'browser',target:'es2022',jsx:'automatic',external:['react','react/jsx-runtime','app-cards/sdk'],metafile:true})
  for(const out of Object.values(result.metafile.outputs) as any[])for(const i of out.imports)if(!['react','react/jsx-runtime','app-cards/sdk'].includes(i.path))throw Error('Unbundled dependency: '+i.path)
  if(result.outputFiles.length!==1)throw Error('Inline component styles; external CSS/assets are not supported')
  const code=`export const apiVersion=1;\nexport function createComponents(runtime){\nconst require=(name)=>{if(name==='react')return runtime.React;if(name==='react/jsx-runtime')return runtime.jsxRuntime;if(name==='app-cards/sdk')return runtime.sdk;throw Error('Unsupported runtime import '+name)};\nconst module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports.components;\n}\n`
  const manifest=manifestSchema.parse({...spec,bundleSha256:hash(code)})
  mkdirSync(dest,{recursive:true});writeFileSync(join(dest,'client.mjs'),code);writeFileSync(join(dest,'manifest.json'),JSON.stringify(manifest)+'\n')
  console.log(JSON.stringify({built:dest,id:manifest.id,version:manifest.version,bundleSha256:manifest.bundleSha256}));return
 }
 if(command==='list'){
  console.log(JSON.stringify({active:store.descriptor(),installed:existsSync(join(root,'packages'))?readdirSync(join(root,'packages')).filter(k=>/^[a-f0-9]{64}$/.test(k)).map(k=>{try{return store.load(k)}catch{return {key:k,error:'integrity failure'}}}):[]},null,2));return
 }
 if(!['install','activate','disable'].includes(command)||!input)throw Error('Usage: build SOURCE OUT | list | install BUNDLE --trust-code | activate KEY | disable ID [--data-path PATH]')
 if(command==='install'&&!args.includes('--trust-code'))throw Error('Review trusted frontend code first, then explicitly pass --trust-code')
 mkdirSync(root,{recursive:true,mode:0o700});const lock=join(root,'.install-lock');mkdirSync(lock)
 try{
  const before=store.read();let next=before;let installDir:string|undefined
  if(command==='disable'){if(!before.some(p=>p.manifest.id===input))throw Error('Extension is not active');next=before.filter(p=>p.manifest.id!==input)}
  else{
   let item
   if(command==='install'){
    installDir=resolve(input)
    const manifest=manifestSchema.parse(JSON.parse(readFileSync(join(installDir,'manifest.json'),'utf8')))
    manifestPackage(manifest)
    const code=readFileSync(join(installDir,'client.mjs'))
    if(code.length>4*1024*1024||hash(code)!==manifest.bundleSha256)throw Error('Extension bundle integrity mismatch')
    item={key:hash(JSON.stringify(manifest)+'\n'),manifest}
    const directory=join(root,'packages')
    for(const key of (existsSync(directory)?readdirSync(directory):[]).filter(k=>/^[a-f0-9]{64}$/.test(k))){const old=store.load(key);if(old.manifest.id===item.manifest.id&&old.manifest.version===item.manifest.version&&old.key!==item.key)throw Error('Version is immutable: increase version before installing changed code')}
   }else item=store.load(input)
   next=[...before.filter(p=>p.manifest.id!==item.manifest.id),item]
  }
  if(next.length>32)throw Error('At most 32 dynamic packages may be active')
  const packages=next.map(p=>manifestPackage(p.manifest));extensionApis([...installedExtensions,...packages])
  setDynamicProvider(()=>packages);const validated=validateCurrent()
  if(installDir){const staged=stagePackage(root,installDir);if(!next.some(p=>p.key===staged.key))throw Error('Package changed during installation')}
  const history=join(root,'history');mkdirSync(history,{recursive:true,mode:0o700})
  writeFileSync(join(history,`${Date.now()}-${process.pid}.json`),JSON.stringify(before.map(p=>p.key))+'\n',{mode:0o600,flag:'wx'})
  writeActive(root,next.map(p=>p.key))
  console.log(JSON.stringify({active:store.descriptor(),validatedPublishedCards:validated,restartRequired:false,refreshBrowser:true}))
 }finally{rmSync(lock,{recursive:true})}
}
main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1})
