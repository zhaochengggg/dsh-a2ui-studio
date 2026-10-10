import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {AppSurface} from '../src/client/renderer.tsx'
import {text as css} from '../src/client/app-cards.module.css'
const style=document.createElement('style');style.textContent=css;document.head.append(style)
const path=(p:string)=>({path:'/checks/gpu/value/'+p})
const components:any[]=[{id:'root',component:'Grid',columns:2,children:['card0','card1']}]
for(let i=0;i<2;i++)components.push(
 {id:`card${i}`,component:'Card',child:`body${i}`,warning:path(`g${i}/throttle`),warningText:`GPU${i} 热降频 · 检查散热与功耗设置`},
 {id:`body${i}`,component:'Column',children:[`title${i}`,`temp${i}`,`power${i}`,`clock${i}`,`mem${i}`]},
 {id:`title${i}`,component:'Text',variant:'h3',text:`GPU ${i}`},
 {id:`temp${i}`,component:'telemetry.v1.Gauge',label:'温度',value:path(`g${i}/temp`),min:20,max:90,unit:'°C'},
 {id:`power${i}`,component:'Progress',label:'功耗',value:path(`g${i}/power`),min:0,max:path('hardwareMax'),marker:path('limit'),unit:'W',colorScale:'thermal'},
 {id:`clock${i}`,component:'Metric',label:'核心频率',value:path(`g${i}/clock`),unit:'MHz'},
 {id:`mem${i}`,component:'Progress',label:'显存',value:path(`g${i}/memory`),min:0,max:16,unit:'GiB',colorScale:'thermal'})
const declaration:any={apiVersion:'dsh.app-cards/v1',kind:'MachineAppCards',machineId:'preview',revision:1,apps:{gpu:{name:'双 GPU'}},contexts:{},data:{},operations:{},actions:{},checks:{},ui:{a2uiVersion:'0.9.1',catalogId:'urn:dsh:app-cards:catalog:1',surfaces:[{id:'main',appId:'gpu',order:0,formInitial:{},components}]}}
function Preview(){
 const [mode,setMode]=useState('normal'),[temp,setTemp]=useState(67),[limit,setLimit]=useState(200),[dark,setDark]=useState(true)
 const sample={hardwareMax:mode==='missing'?null:300,limit,g0:{temp:61,power:198,clock:1530,throttle:false,memory:15.7},g1:{temp:mode==='warning'?86:temp,power:mode==='warning'?222:201,clock:mode==='warning'?502:1530,throttle:mode==='warning',memory:15.7}}
 const snapshot:any={machineId:'preview',revision:1,actions:{},runs:[],checks:{gpu:{revision:1,observedAt:Date.now(),expiresAt:mode==='stale'?0:Date.now()+60000,health:'healthy',value:sample}}}
 return <main className="preview" data-theme={dark?'dark':'light'}><header><h1>双 GPU · 组件验收</h1><p>模拟数据，仅验证界面；不读取、不控制服务器硬件。</p><label>场景 <select aria-label="场景" value={mode} onChange={e=>setMode(e.target.value)}><option value="normal">正常</option><option value="warning">GPU1 热降频</option><option value="stale">观测过期</option><option value="missing">上限未知</option></select></label><label>GPU1 温度 <input aria-label="GPU1 温度" type="range" min="20" max="90" value={temp} onChange={e=>setTemp(+e.target.value)}/></label><label>功耗设定 <input aria-label="功耗设定" type="range" min="150" max="250" value={limit} onChange={e=>setLimit(+e.target.value)}/>{limit} W</label><button onClick={()=>setDark(!dark)}>切换明暗</button></header><div className="dsh-ac-region"><AppSurface declaration={declaration} surfaceId="main" host={{snapshot,busy:false,invoke:()=>{},cancel:()=>{}}}/></div></main>
}
createRoot(document.getElementById('root')!).render(<Preview/>);
