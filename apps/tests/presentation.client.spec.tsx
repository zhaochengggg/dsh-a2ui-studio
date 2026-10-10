// @vitest-environment jsdom
import {cleanup,render,screen,fireEvent} from '@testing-library/react'
import {afterEach,it,expect,vi} from 'vitest'
import {AppCardRenderer,ResolvedSurface} from '../src/client/renderer.tsx'
import {previewSnapshot,previewScenariosSchema} from '../src/preview.ts'
import {interactionFixture} from './interaction-fixture.ts'
import {validateUi} from '../src/ui-catalog.ts'
import {AppCards} from '../src/client/AppCards.tsx'
const rs:AppCardRenderer[]=[]
afterEach(()=>{cleanup();rs.splice(0).forEach(r=>r.dispose())})
function fixture(){const d:any=interactionFixture();d.checks.metrics={appId:'gpu',label:'GPU',operation:'probe',input:{literal:{}},evaluate:{language:'jsonata',source:'{}'},freshForMs:10000};d.actions.reset={...d.actions.apply,label:'恢复'};d.ui.surfaces[0].components=[
 {id:'root',component:'Column',children:['status','gauge','receipt','sync','apply']},
 {id:'status',component:'Status',checkId:'metrics'},
 {id:'gauge',component:'telemetry.v1.Gauge',label:'功耗',value:{path:'/checks/metrics/value/power'},max:300,marker:200,unit:'W',variant:'compact'},
 {id:'receipt',component:'RunReceipt',actionIds:['apply','reset']},
 ...d.ui.surfaces[0].components.filter((c:any)=>['sync','apply','apply-label'].includes(c.id))
 ];d.ui.previewScenarios=[{name:'正常',checks:{metrics:{health:'healthy',summary:'两卡正常',value:{power:180}}}},{name:'异常',checks:{metrics:{health:'unhealthy',summary:'GPU 1 热降频',value:{power:230}}},runs:[{actionId:'reset',state:'running'}]}];return d}
it('compact status keeps details accessible; busy is not stale; idle receipt is hidden',()=>{
 const d=fixture(),snapshot=previewSnapshot(d,d.ui.previewScenarios[0]),r=new AppCardRenderer(d,'main',vi.fn(),snapshot);rs.push(r)
 const v=render(<ResolvedSurface renderer={r} host={{snapshot,busy:true,invoke:vi.fn(),cancel:vi.fn()}}/>)
 expect(screen.getByRole('status').getAttribute('data-health')).toBe('healthy');expect(screen.queryByText('暂无运行')).toBeNull()
 expect(v.container.querySelector('details')?.open).toBe(false)
 fireEvent.click(screen.getByText('健康'));expect(v.container.querySelector('details')?.open).toBe(true)
 expect(screen.getByText('两卡正常')).toBeTruthy();expect(screen.getByRole('meter').getAttribute('aria-valuemax')).toBe('300')
 expect(v.container.querySelector('[data-compact=true]')).toBeTruthy()
})
it('preview cannot invoke or cancel simulated actions; rejects unknown evidence',()=>{
 const d=fixture(),snapshot=previewSnapshot(d,d.ui.previewScenarios[1]),action=vi.fn(),cancel=vi.fn(),r=new AppCardRenderer(d,'main',action,snapshot);rs.push(r)
 render(<ResolvedSurface renderer={r} host={{snapshot,busy:true,invoke:action,cancel}}/>)
 fireEvent.click(screen.getByRole('button',{name:'应用（模拟）'}));fireEvent.click(screen.getByRole('button',{name:'取消运行',hidden:true}));expect(action).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled()
 expect(screen.getByText('执行中 · 恢复')).toBeTruthy()
 expect(()=>previewSnapshot(d,{name:'invalid',checks:{missing:{value:{},health:'healthy',summary:''}}})).toThrow('Unknown preview check')
 expect(()=>previewScenariosSchema.parse([{name:'bad',checks:{},execute:true}])).toThrow()
})
it('validates shared visibility, grouped receipts and exclusive selectors',()=>{
 const d=fixture();expect(()=>validateUi(d)).not.toThrow()
 const receipt=d.ui.surfaces[0].components.find((c:any)=>c.id==='receipt');receipt.visible=false
 expect(()=>validateUi(d)).not.toThrow();receipt.actionId='apply';expect(()=>validateUi(d)).toThrow()
})
it('panel preview selector renders author scenarios without calling live operations',async()=>{
 const d=fixture(),live=previewSnapshot(d),previewCard=vi.fn(async()=>live),invoke=vi.fn(),cancel=vi.fn()
 render(<AppCards {...{machineId:'demo',openKey:1,refreshKey:1,useAppCards:(f:any)=>f({machineId:'demo',data:{...live,drafts:[{id:'draft',revision:2,createdAt:Date.now()}]},pending:false,error:null}),openCards:()=>()=>{},invokeCard:invoke,cancelRun:cancel,rereadCards:vi.fn(),refreshCards:vi.fn(),previewCard} as any}/> )
 fireEvent.change(screen.getByLabelText('卡片版本'),{target:{value:'draft'}})
 const selector=await screen.findByLabelText('预览场景');fireEvent.change(selector,{target:{value:'1'}})
 expect(await screen.findByText('GPU 1 热降频')).toBeTruthy();expect(screen.getByText('模拟预览 · 非真实观测，所有操作禁用')).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'应用（模拟）'}));expect(invoke).not.toHaveBeenCalled()
})
