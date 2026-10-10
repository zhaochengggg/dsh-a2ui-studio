// @vitest-environment jsdom
import {it,expect,afterEach,vi} from 'vitest'
import {act,render,screen,cleanup} from '@testing-library/react'
import {loadDynamicExtensions,extensionFailures} from '../src/extensions/dynamic-client.ts'
import {setDynamicProvider} from '../src/extensions/dynamic-schema.ts'
import {extensionViews} from '../src/extensions/client.tsx'
import {AppCardRenderer,ResolvedSurface,AppSurface} from '../src/client/renderer.tsx'
const manifest={format:1,apiVersion:1,id:'test.v1',version:'1.0.0',description:'Test',bundleSha256:'a'.repeat(64),components:[{name:'test.v1.Test',properties:{label:{type:'text'},value:{type:'number',binding:true}}}]}
const catalog={generation:'b'.repeat(64),packages:[{key:'c'.repeat(64),manifest}]}
const fetcher=async()=>({ok:true,json:async()=>catalog}) as any
const renderers:AppCardRenderer[]=[]
afterEach(()=>{cleanup();renderers.splice(0).forEach(r=>r.dispose());setDynamicProvider(()=>[]);delete extensionViews['test.v1.Test'];vi.restoreAllMocks()})
function doc(){return {apiVersion:'dsh.app-cards/v1',kind:'MachineAppCards',machineId:'test',revision:1,apps:{app:{name:'Test'}},contexts:{},data:{v:12},operations:{},actions:{},checks:{},ui:{a2uiVersion:'0.9.1',catalogId:'urn:dsh:app-cards:catalog:1',surfaces:[{id:'test',appId:'app',order:0,formInitial:{},components:[{id:'root',component:'test.v1.Test',label:'Custom',value:{path:'/data/v'}}]}]}} as any}
it('loads matching package and renders reactive A2UI data with the host React runtime',async()=>{
 const importer=vi.fn(async()=>({apiVersion:1,createComponents:({React}:any)=>({'test.v1.Test':({value}:any)=>React.createElement('strong',null,`${value('label')}: ${value('value')}`)})}))
 await loadDynamicExtensions(fetcher as any,importer);expect(importer).toHaveBeenCalledWith('/app-card-extensions/'+'c'.repeat(64)+'/client.mjs')
 const r=new AppCardRenderer(doc(),'test',()=>{});renderers.push(r);render(<ResolvedSurface renderer={r}/>);expect(screen.getByText('Custom: 12')).toBeTruthy()
 act(()=>r.process([{version:'v0.9.1',updateDataModel:{surfaceId:'test',path:'/data/v',value:13}}]));expect(screen.getByText('Custom: 13')).toBeTruthy()
})
it('component load failures stay local; builtin siblings still render',async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{})
 await loadDynamicExtensions(fetcher as any,async()=>{throw Error('bad module')})
 const d=doc();d.ui.surfaces[0].components[0].id='custom';d.ui.surfaces[0].components.push({id:'root',component:'Column',children:['custom','ok']},{id:'ok',component:'Text',text:'Builtin healthy'})
 const r=new AppCardRenderer(d,'test',()=>{});renderers.push(r);render(<ResolvedSurface renderer={r}/>);expect(screen.getByText('Builtin healthy')).toBeTruthy();expect(screen.getByRole('alert').textContent).toContain('加载失败');expect(extensionFailures['test.v1']).toContain('bad module')
})
it('shares nested function bindings and common visibility with independent extensions',async()=>{
 await loadDynamicExtensions(fetcher as any,async()=>({apiVersion:1,createComponents:({React}:any)=>({'test.v1.Test':({value}:any)=>React.createElement('strong',null,`Computed: ${value('value')}`)})}))
 const d=doc();Object.assign(d.ui.surfaces[0].components[0],{value:{call:'multiply',args:{a:{path:'/data/v'},b:2}},visible:{call:'greater_than',args:{a:{path:'/data/v'},b:0}}})
 const r=new AppCardRenderer(d,'test',()=>{});renderers.push(r);render(<ResolvedSurface renderer={r}/>)
 expect(screen.getByText('Computed: 24')).toBeTruthy()
 act(()=>r.process([{version:'v0.9.1',updateDataModel:{surfaceId:'test',path:'/data/v',value:0}}]));expect(screen.queryByText('Computed: 0')).toBeNull()
})
it('rejects unsupported API and generation mismatch instead of mixing versions',async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{})
 await loadDynamicExtensions(fetcher as any,async()=>({apiVersion:2}))
 expect(extensionFailures['test.v1']).toContain('Unsupported')
 expect(()=>new AppCardRenderer(doc(),'test',()=>{},{extensionGeneration:'d'.repeat(64)} as any)).toThrow('刷新')
})
