import {createRoot} from 'react-dom/client'
import {useState} from 'react'
import {AppSurface} from '../src/client/renderer.tsx'
import {interactionFixture} from './interaction-fixture.ts'
import {text} from '../src/client/app-cards.module.css'
const style=document.createElement('style');style.textContent=text;document.head.append(style)
const doc=interactionFixture()
function Demo(){const [result,setResult]=useState('尚未提交');return <main><header><h1>双卡联动 · 交互验收</h1><p>全部为模拟数据，不连接真实 GPU。</p></header><section className="dsh-ac-region" style={{maxWidth:560}}><AppSurface declaration={doc} surfaceId="main" host={{snapshot:{machineId:doc.machineId,revision:1,sequence:1,declaration:doc,checks:{},actions:{apply:{enabled:true}},runs:[]},busy:false,invoke:(_id,input)=>setResult(JSON.stringify(input,null,2)),cancel:()=>{}}}/><p>实际提交参数</p><pre aria-label="实际提交参数">{result}</pre></section></main>}
createRoot(document.getElementById('root')!).render(<Demo/> )
