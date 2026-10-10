import {createRoot} from 'react-dom/client'
import {useState} from 'react'
import {AppCards} from '../src/client/AppCards.tsx'
import {text} from '../src/client/app-cards.module.css'
import {previewSnapshot} from '../src/preview.ts'
import {interactionFixture} from './interaction-fixture.ts'
const style=document.createElement('style');style.textContent=text;document.head.append(style)
const d:any=interactionFixture();d.checks.metrics={appId:'gpu',label:'GPU',operation:'probe',input:{literal:{}},evaluate:{language:'jsonata',source:'{}'},freshForMs:10000}
const f=(gpu:number,key:string)=>({path:`/checks/metrics/value/gpus/${gpu}/${key}`})
const original=d.ui.surfaces[0].components
d.ui.surfaces[0].components=[{id:'root',component:'Column',children:['status','cards','sync','shared','separate','apply','receipt']},
 {id:'status',component:'Status',checkId:'metrics'},
 {id:'cards',component:'Grid',columns:2,children:['c0','c1']},
 ...[0,1].flatMap(i=>[{id:'c'+i,component:'Card',child:'col'+i,warning:f(i,'warning'),warningText:'热降频'},
 {id:'col'+i,component:'Column',children:['title'+i,'temp'+i,'power'+i]},
 {id:'title'+i,component:'Text',text:'GPU '+i,variant:'h4'},
 {id:'temp'+i,component:'telemetry.v1.Gauge',label:'温度',value:f(i,'temp'),max:90,unit:'°C',variant:'compact'},
 {id:'power'+i,component:'telemetry.v1.Gauge',label:'功耗',value:f(i,'power'),max:300,marker:200,unit:'W',variant:'compact'}]),
 ...original.filter((c:any)=>['sync','shared','separate','gpu0','gpu1','apply','apply-label'].includes(c.id)),{id:'receipt',component:'RunReceipt',actionId:'apply'}]
const scenario=(name:string,warning=false,stale=false)=>({name,checks:{metrics:{health:warning?'unhealthy':'healthy',summary:warning?'GPU 1 热降频':'两卡正常',stale,value:{gpus:[{temp:48,power:170,warning:false},{temp:warning?86:50,power:195,warning}]}}},...(warning?{runs:[{actionId:'apply',state:'failed',value:{message:'模拟失败，不是真实执行'}}]}:{})})
d.ui.previewScenarios=[scenario('正常'),scenario('异常',true),scenario('过期',false,true)]
const snapshot={...previewSnapshot(d),drafts:[{id:'draft',revision:1,createdAt:Date.now()}]}
const props:any={machineId:'demo',openKey:1,refreshKey:1,useAppCards:(f:any)=>f({machineId:'demo',data:snapshot,pending:false,error:null}),openCards:()=>()=>{},previewCard:async()=>snapshot,invokeCard:()=>{throw Error('preview must not execute')},cancelRun:()=>{throw Error('preview must not cancel')},rereadCards:()=>{},refreshCards:()=>{}}
function Demo(){const [narrow,setNarrow]=useState(false),[dark,setDark]=useState(true);return <main data-theme={dark?'dark':'light'}><header><h1>宿主集成预览验收</h1><p>同一机器面板样式 + 同一应用组件。所有数据均为模拟。</p><button onClick={()=>setNarrow(!narrow)}>切换宽窄</button> <button onClick={()=>setDark(!dark)}>切换主题</button></header><div className="mm-panel" style={{width:narrow?350:800,maxWidth:'100%',height:'auto',margin:'20px auto',padding:18}}><AppCards {...props}/></div></main>}
createRoot(document.getElementById('root')!).render(<Demo/> )
