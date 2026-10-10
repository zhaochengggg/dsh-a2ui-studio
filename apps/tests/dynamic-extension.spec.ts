import {it,expect,afterEach} from 'vitest'
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {DatabaseSync} from 'node:sqlite'
import {DynamicExtensions,stagePackage,writeActive,hash,registerExtensionRoutes} from '../src/extensions/dynamic-host.ts'
import {manifestPackage,setDynamicProvider} from '../src/extensions/dynamic-schema.ts'
import {validateUi,catalogApis} from '../src/ui-catalog.ts'
const dirs:string[]=[]
const temp=()=>{const p=mkdtempSync(join(tmpdir(),'ac-dynamic-'));dirs.push(p);return p}
afterEach(()=>{setDynamicProvider(()=>[]);dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}))})
const manifest=(version='1.0.0')=>({format:1,apiVersion:1,id:'demo.v1',version,description:'test',components:[{name:'demo.v1.Test',properties:{value:{type:'number',binding:true},max:{type:'number'},child:{type:'child',optional:true}}}],bundleSha256:hash('export const apiVersion=1')})
function bundle(version='1.0.0'){const p=temp();writeFileSync(join(p,'manifest.json'),JSON.stringify(manifest(version)));writeFileSync(join(p,'client.mjs'),'export const apiVersion=1');return p}
function doc(){return {apps:{app:{name:'Test'}},ui:{a2uiVersion:'0.9.1',catalogId:'urn:dsh:app-cards:catalog:1',surfaces:[{id:'s',appId:'app',order:0,formInitial:{},components:[{id:'root',component:'demo.v1.Test',value:{path:'/data/value'},max:100}]}]}} as any}
it('discovers installation and rollback without reconstructing the host',()=>{
 const root=temp(),host=new DynamicExtensions(root);setDynamicProvider(()=>host.packages());expect(()=>validateUi(doc())).toThrow('Unknown')
 const one=stagePackage(root,bundle()),two=stagePackage(root,bundle('1.0.1'))
 writeActive(root,[one.key]);expect(()=>validateUi(doc())).not.toThrow();const before=host.descriptor().generation
 writeActive(root,[two.key]);expect(host.packages()[0].version).toBe('1.0.1');expect(host.descriptor().generation).not.toBe(before)
 writeActive(root,[one.key]);expect(host.descriptor().generation).toBe(before)
 expect(host.asset(two.key)).toContain('apiVersion')
})
it('rejects altered bundles, path traversal, invalid keys and duplicate packages',()=>{
 const root=temp(),one=stagePackage(root,bundle());writeActive(root,[one.key,one.key]);expect(()=>new DynamicExtensions(root).read()).toThrow('Invalid')
 expect(()=>new DynamicExtensions(root).asset('../../secret')).toThrow('Invalid')
 writeFileSync(join(root,'packages',one.key,'client.mjs'),'changed');expect(()=>new DynamicExtensions(root).load(one.key)).toThrow('integrity')
 expect(()=>manifestPackage({...manifest(),apiVersion:2})).toThrow()
})
it('retains strict property, binding and graph validation for dynamic components',()=>{
 const p=manifestPackage(manifest());setDynamicProvider(()=>[p]);expect(catalogApis().some(a=>a.name==='demo.v1.Test')).toBe(true)
 const d=doc();d.ui.surfaces[0].components[0].child='missing';expect(()=>validateUi(d)).toThrow('Unknown component reference')
 delete d.ui.surfaces[0].components[0].child;d.ui.surfaces[0].components[0].value={path:'/data/__proto__/x'};expect(()=>validateUi(d)).toThrow()
 d.ui.surfaces[0].components[0].value=5;d.ui.surfaces[0].components[0].onClick='bad';expect(()=>validateUi(d)).toThrow()
})
it('serves immutable assets only through the existing admission fence',()=>{
 let handler:any,deny=true;const root=temp(),one=stagePackage(root,bundle());writeActive(root,[one.key])
 registerExtensionRoutes({inject:(_keys:any,fn:any)=>fn({connection:{admit:()=>deny?{rejection:403}:{peer:{}}},effect:(fn:any)=>fn(),webServer:{register:(r:any)=>{handler=r.handler;return ()=>{}}}})},new DynamicExtensions(root))
 const res:any={status:0,body:'',writeHead(n:number){this.status=n},end(s:string){this.body=s}}
 handler({method:'GET',url:'/app-card-extensions/catalog.json'},res);expect(res.status).toBe(403)
 deny=false;handler({method:'GET',url:'/app-card-extensions/catalog.json'},res);expect(res.status).toBe(200);expect(JSON.parse(res.body).packages[0].key).toBe(one.key)
 handler({method:'POST',url:'/app-card-extensions/catalog.json'},res);expect(res.status).toBe(405)
 handler({method:'GET',url:`/app-card-extensions/${one.key}/client.mjs`},res);expect(res.status).toBe(200)
})
it('built CLI independently builds, installs and rolls back; incompatible removal leaves registry intact',()=>{
 const data=temp(),out=temp(),cli=join(process.cwd(),'apps/lib/extensionctl.js')
 const run=(...args:string[])=>JSON.parse(execFileSync(process.execPath,[cli,...args,'--data-path',data],{encoding:'utf8'}))
 run('build','apps/examples/extensions/range',out)
 expect(()=>run('install',out)).toThrow()
 const result=run('install',out,'--trust-code');expect(result.restartRequired).toBe(false)
 const key=result.active.packages[0].key;run('disable','range-demo.v1');run('activate',key)
 const d=JSON.parse(readFileSync('apps/examples/minimal.json','utf8'))
 // Use only the real declaration fixture shape; replace its UI with the dynamic component.
 d.ui.surfaces[0].components=[{id:'root',component:'range-demo.v1.Meter',label:'Test',value:1,max:10}]
 const dir=join(data,'machines',d.machineId,'revisions');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`${d.revision}-test.json`),JSON.stringify(d))
 const db=new DatabaseSync(join(data,'state.sqlite3'));db.exec('CREATE TABLE machines(id TEXT,revision INTEGER,document_digest TEXT,deleted INTEGER)');db.prepare('INSERT INTO machines VALUES(?,?,?,0)').run(d.machineId,d.revision,'test');db.close()
 const before=readFileSync(join(data,'extensions','active.json'),'utf8');expect(()=>run('disable','range-demo.v1')).toThrow();expect(readFileSync(join(data,'extensions','active.json'),'utf8')).toBe(before)
})
