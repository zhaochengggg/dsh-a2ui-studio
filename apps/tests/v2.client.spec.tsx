// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {AppCardRenderer,ResolvedSurface} from '../src/client/renderer.tsx'
import {AppCardsController} from '../src/client/controller.ts'
import {parseDeclaration} from '../src/declaration.ts'
import {validateUi} from '../src/ui-catalog.ts'
const owned:any[]=[]
afterEach(()=>{cleanup();owned.splice(0).forEach(x=>x.dispose());vi.useRealTimers()})
function doc(){return {apiVersion:'dsh.app-cards/v1',kind:'MachineAppCards',machineId:'test',revision:1,apps:{app:{name:'Tuning'}},contexts:{},data:{history:[1,4,2]},operations:{echo:{kind:'transform',inputSchema:{type:'object'},input:{ref:'/input'},source:'$',outputSchema:{type:'object'},timeoutMs:1000}},actions:{apply:{appId:'app',label:'应用',operation:'echo',input:{ref:'/input'},availability:{kind:'always'},invalidates:[]}},checks:{},ui:{a2uiVersion:'0.9.1',catalogId:'urn:dsh:app-cards:catalog:1',surfaces:[{id:'main',appId:'app',order:0,formInitial:{limit:4},components:[
 {id:'root',component:'Column',children:['metrics','slider','number','button','progress','trend','link']},
 {id:'metrics',component:'Grid',columns:2,children:['metric']},
 {id:'metric',component:'Metric',label:'当前值',value:{path:'/checks/measure/value/n'},unit:'W'},
 {id:'slider',component:'Slider',label:'拟设置',value:{path:'/form/limit'},min:1,max:10},
 {id:'number',component:'NumberField',label:'数字',value:{path:'/form/limit'},min:1,max:10},
 {id:'button',component:'Button',child:'label',action:{event:{name:'app.invoke',context:{actionId:'apply',input:{path:'/form'}}}}},
 {id:'label',component:'Text',text:'应用'},
 {id:'progress',component:'Progress',label:'进度',value:{path:'/checks/measure/value/n'}},
 {id:'trend',component:'Sparkline',label:'趋势',values:{path:'/data/history'}},
 {id:'link',component:'Link',label:'不安全链接',url:'javascript:alert(1)'}
]}]}}}
it('renders absent observations, numeric edits, safe links and preserves draft on observation updates',()=>{
 const d=parseDeclaration(doc());validateUi(d);const action=vi.fn();const r=new AppCardRenderer(d,'main',action);owned.push(r)
 render(<ResolvedSurface renderer={r}/>);
 expect(screen.getByText('当前值')).toBeTruthy();expect(screen.queryByRole('link')).toBeNull()
 fireEvent.change(screen.getByRole('slider'),{target:{value:'7'}})
 expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('7')
 act(()=>r.process([{version:'v0.9.1',updateDataModel:{surfaceId:'main',path:'/checks',value:{measure:{value:{n:8}}}}}]))
 expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('7')
 fireEvent.click(screen.getByRole('button',{name:'应用'}));expect(action.mock.calls[0][0].context.input).toEqual({limit:7})
})
it('rejects invalid slider bounds and readonly value writes',()=>{
 const d=doc();d.ui.surfaces[0].components[3].max=0;expect(()=>validateUi(d as any)).toThrow('max > min')
 const e=doc();e.ui.surfaces[0].components[3].value={path:'/checks/x/value'};expect(()=>validateUi(e as any)).toThrow('may write only')
})
it('monitoring only runs while the selected panel and document are visible',async()=>{
 vi.useFakeTimers();const declaration=parseDeclaration({...doc(),monitoring:{intervalMs:5000}})
 const state={machineId:'test',revision:1,sequence:1,declaration,checks:{},runs:[],actions:{}}
 const remote:any={read:vi.fn(async()=>({ok:true,value:state})),refresh:vi.fn(async()=>({ok:true,value:[]}))}
 const c=new AppCardsController(remote,vi.fn());owned.push(c);const release=c.open('test' as any,1,0)
 await vi.advanceTimersByTimeAsync(1);expect(remote.refresh).toHaveBeenCalledTimes(1)
 await vi.advanceTimersByTimeAsync(5000);expect(remote.refresh).toHaveBeenCalledTimes(2)
 vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');await vi.advanceTimersByTimeAsync(10000);expect(remote.refresh).toHaveBeenCalledTimes(2)
 release();await vi.advanceTimersByTimeAsync(10000);expect(remote.refresh).toHaveBeenCalledTimes(2)
 vi.restoreAllMocks()
})
it('periodic checks cannot spend model tokens',()=>{
 const d=doc();d.monitoring={intervalMs:5000};d.operations.agent={kind:'agent',prompt:'reason',inputSchema:{type:'object'},input:{literal:{}},allowedOperations:[],outputSchema:{},timeoutMs:1000,completion:'result'};d.checks.health={appId:'app',label:'Health',operation:'agent',input:{literal:{}},evaluate:{language:'jsonata',source:'{}'},freshForMs:1000};expect(()=>parseDeclaration(d)).toThrow('must not invoke an agent')
})
it('ignores a superseded response instead of unmounting cards and losing form drafts',async()=>{
 const declaration=parseDeclaration(doc());const state={machineId:'test',revision:1,sequence:1,declaration,checks:{},runs:[],actions:{}}
 const first=Promise.withResolvers<any>(),second=Promise.withResolvers<any>()
 const remote:any={read:vi.fn().mockResolvedValue({ok:true,value:state}),refresh:vi.fn(async()=>({ok:true,value:[]}))}
 const report=vi.fn(),c=new AppCardsController(remote,report);owned.push(c);c.open('test' as any,1,0)
 await new Promise(r=>setTimeout(r,0))
 remote.read.mockImplementationOnce(()=>first.promise).mockImplementationOnce(()=>second.promise)
 c.reread();c.changed({machineId:'test' as any,revision:1,sequence:2,kind:'run'})
 first.resolve({ok:true,value:state});await new Promise(r=>setTimeout(r,0))
 expect(c.getSnapshot().data?.declaration).toBeTruthy();expect(report).not.toHaveBeenCalled()
 second.resolve({ok:true,value:{...state,sequence:2}});await new Promise(r=>setTimeout(r,0))
 expect(c.getSnapshot().data?.sequence).toBe(2)
})
