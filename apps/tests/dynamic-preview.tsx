import {createRoot} from 'react-dom/client'
import {useState} from 'react'
import {loadDynamicExtensions,loadedGeneration} from '../src/extensions/dynamic-client.ts'
import {dynamicPackages} from '../src/extensions/dynamic-schema.ts'
import {AppSurface} from '../src/client/renderer.tsx'
import {text} from '../src/client/app-cards.module.css'
const style=document.createElement('style');style.textContent=text;document.head.append(style)
function Demo(){const [n,setN]=useState(150);const packs=dynamicPackages();const pack=packs.find(p=>p.id==='range-demo.v1')
 const doc:any={apiVersion:'dsh.app-cards/v1',kind:'MachineAppCards',machineId:'demo',revision:1,apps:{app:{name:'demo'}},contexts:{},data:{},operations:{},actions:{},checks:{},ui:{a2uiVersion:'0.9.1',catalogId:'urn:dsh:app-cards:catalog:1',surfaces:[{id:'demo',appId:'app',order:0,formInitial:{},components:[{id:'root',component:'range-demo.v1.Meter',label:'功耗 · 模拟值',value:{path:'/checks/gpu/value'},max:300,marker:200,unit:'W',child:'caption'},{id:'caption',component:'Text',text:'原生子组件正常渲染；未连接真实硬件。'}]}]}}
 return <main style={{maxWidth:650,margin:'50px auto',padding:24,fontFamily:'system-ui',color:'inherit'}}><h1>独立组件加载验收</h1><p>隔离测试，不读取或操作真实 GPU。</p><p>当前扩展：{pack?`${pack.id} · ${pack.version}`:'尚未安装'}</p>{pack?<><label>模拟功耗 <input aria-label="模拟功耗" type="range" min="0" max="320" value={n} onChange={e=>setN(Number(e.target.value))}/></label><section style={{marginTop:28,padding:22,border:'1px solid #444',borderRadius:12}}><AppSurface declaration={doc} surfaceId="demo" host={{snapshot:{extensionGeneration:loadedGeneration,machineId:'demo' as any,revision:1,sequence:1,declaration:doc,checks:{gpu:{revision:1,value:n,expiresAt:Date.now()+600000,observedAt:Date.now()} as any},actions:{},runs:[]},busy:false,invoke:()=>{},cancel:()=>{}}}/></section></>:null}</main>
}
loadDynamicExtensions().then(()=>createRoot(document.getElementById('root')!).render(<Demo/>)).catch(e=>{document.getElementById('root')!.textContent=String(e)})
