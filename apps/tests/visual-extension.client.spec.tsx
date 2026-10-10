// @vitest-environment jsdom
import {act,cleanup,render,screen} from '@testing-library/react'
import {afterEach,it,expect,vi} from 'vitest'
import {AppCardRenderer,AppSurface,ResolvedSurface} from '../src/client/renderer.tsx'
import {scaleColor,ratio} from '../src/client/color-scale.ts'
import {validateUi,catalogApis} from '../src/ui-catalog.ts'
import {extensionApis} from '../src/extensions/registry.ts'
import {installedExtensions} from '../src/extensions/installed.ts'
import {extensionViews,validateExtensionViews} from '../src/extensions/client.tsx'
const owned:AppCardRenderer[]=[]
afterEach(()=>{cleanup();owned.splice(0).forEach(r=>r.dispose());vi.useRealTimers()})
function doc(components:any[]){return {apiVersion:'dsh.app-cards/v1',kind:'MachineAppCards',machineId:'test',revision:1,apps:{app:{name:'Test'}},contexts:{},data:{v:150,max:300,limit:200},operations:{},actions:{},checks:{},ui:{a2uiVersion:'0.9.1',catalogId:'urn:dsh:app-cards:catalog:1',surfaces:[{id:'test',appId:'app',order:0,formInitial:{},components}]}} as any}
function show(d:any,host?:any){const r=new AppCardRenderer(d,'test',()=>{},host?.snapshot);owned.push(r);const v=render(<ResolvedSurface renderer={r} host={host}/>);return {r,...v}}
it('interpolates continuously through the full range; clamps only display and rejects invalid data',()=>{
 const colors=Array.from({length:101},(_,i)=>scaleColor(i,0,100));expect(new Set(colors).size).toBe(101)
 const channels=(s:string)=>s.match(/\d+/g)!.map(Number)
 for(let i=1;i<colors.length;i++)expect(Math.max(...channels(colors[i]!).map((c,k)=>Math.abs(c-channels(colors[i-1]!)[k])))).toBeLessThan(20)
 expect(scaleColor(-1,0,100)).toBe(colors[0]);expect(scaleColor(200,0,100)).toBe(colors[100])
 expect(scaleColor(0,0,100,true)).toBe(colors[100]);expect(ratio(1,2,2)).toBeNull();expect(scaleColor(null,0,100)).toBeUndefined();expect(scaleColor(NaN,0,100)).toBeUndefined()
})
it('registers custom schema and client rendering without adding a renderer switch case',()=>{
 expect(catalogApis().map(c=>c.name)).toContain('telemetry.v1.Gauge');expect(()=>validateExtensionViews()).not.toThrow()
 expect(()=>extensionApis([...installedExtensions,...installedExtensions])).toThrow('Duplicate')
 expect(()=>extensionApis(installedExtensions,['telemetry.v1.Gauge'])).toThrow('duplicate')
 const d=doc([{id:'root',component:'telemetry.v1.Gauge',label:'功耗',value:{path:'/data/v'},max:{path:'/data/max'},marker:{path:'/data/limit'},unit:'W'}]);validateUi(d)
 const {r,container}=show(d);const meter=screen.getByRole('meter');expect(meter.getAttribute('aria-valuemax')).toBe('300')
 const fill=meter.firstElementChild as HTMLElement;expect(fill.style.width).toBe('50%');const color=fill.style.backgroundColor
 act(()=>r.process([{version:'v0.9.1',updateDataModel:{surfaceId:'test',path:'/data/limit',value:220}}]))
 expect(fill.style.width).toBe('50%');expect(fill.style.backgroundColor).toBe(color);expect(screen.getByTitle('设定值 220 W')).toBeTruthy()
 act(()=>r.process([{version:'v0.9.1',updateDataModel:{surfaceId:'test',path:'/data/v',value:320}}]))
 expect(fill.style.width).toBe('100%');expect(container.textContent).toContain('320 / 300 W')
})
it('warning card is independent of numeric utilization, expires without further polling',()=>{
 vi.useFakeTimers();const expiresAt=Date.now()+1000
 const d=doc([{id:'root',component:'Card',child:'metric',warning:{path:'/checks/gpu/value/throttle'},warningText:'GPU1 热降频'},{id:'metric',component:'Metric',label:'显存',value:{path:'/checks/gpu/value/memory'},colorScale:'thermal',colorMin:0,colorMax:100}])
 const host:any={snapshot:{revision:1,checks:{gpu:{revision:1,value:{throttle:false,memory:99},expiresAt,observedAt:Date.now()}}},busy:false}
 const {container,r,rerender}=show(d,host)
 const card=()=>container.querySelector('section')!
 expect(card().getAttribute('data-warning')).toBe('false');expect((container.querySelector('strong') as HTMLElement).style.color).not.toBe('')
 host.snapshot={...host.snapshot,checks:{gpu:{...host.snapshot.checks.gpu,value:{throttle:true,memory:99}}}}
 act(()=>r.process([{version:'v0.9.1',updateDataModel:{surfaceId:'test',path:'/checks',value:host.snapshot.checks}}]))
 rerender(<ResolvedSurface renderer={r} host={{...host}}/>);expect(card().getAttribute('data-warning')).toBe('true');expect(screen.getByText('GPU1 热降频')).toBeTruthy()
 act(()=>vi.advanceTimersByTime(1100));expect(card().getAttribute('data-warning')).toBe('false');expect(screen.queryByText('GPU1 热降频')).toBeNull();expect((container.querySelector('strong') as HTMLElement).style.color).toBe('')
})
it('rejects backwards static range, unsafe bindings and invented JS properties',()=>{
 for(const props of [{min:100,max:0},{colorMin:5,colorMax:5},{max:{path:'/data/__proto__/max'}},{onClick:'alert(1)'}])expect(()=>validateUi(doc([{id:'root',component:'telemetry.v1.Gauge',label:'x',value:1,max:10,...props}]))).toThrow()
})
it('a missing bound maximum is unknown, never a fabricated 100 or zero',()=>{
 const d=doc([{id:'root',component:'telemetry.v1.Gauge',label:'未知上限',value:50,max:{path:'/data/missing'}}]);show(d)
 expect(screen.getByRole('img').getAttribute('aria-valuenow')).toBeNull();expect(screen.getByRole('img').firstElementChild).toBeNull()
})
it('surface updates survive new callback identity and declaration replacement',()=>{
 const d=doc([{id:'root',component:'Metric',label:'Current',value:{path:'/checks/gpu/value/n'}}]);const snapshot:any={revision:1,checks:{gpu:{revision:1,value:{n:3},expiresAt:Date.now()+10000}},actions:{},runs:[]}
 const v=render(<AppSurface declaration={d} surfaceId="test" host={{snapshot,busy:false,invoke:()=>{},cancel:()=>{}}}/>)
 const next={...snapshot,checks:{gpu:{...snapshot.checks.gpu,value:{n:4}}}}
 v.rerender(<AppSurface declaration={d} surfaceId="test" host={{snapshot:next,busy:false,invoke:()=>{},cancel:()=>{}}}/>);expect(screen.getByText('4')).toBeTruthy()
 v.rerender(<AppSurface declaration={{...d}} surfaceId="test" host={{snapshot:next,busy:false,invoke:()=>{},cancel:()=>{}}}/>);expect(screen.getByText('4')).toBeTruthy()
})
it('isolates a custom component render failure from native siblings',()=>{
 const original=extensionViews['telemetry.v1.Gauge'];const log=vi.spyOn(console,'error').mockImplementation(()=>{})
 try{extensionViews['telemetry.v1.Gauge']=()=>{throw Error('fixture')};show(doc([{id:'root',component:'Column',children:['custom','normal']},{id:'custom',component:'telemetry.v1.Gauge',label:'x',value:1,max:10},{id:'normal',component:'Text',text:'Still available'}]));expect(screen.getByRole('alert')).toBeTruthy();expect(screen.getByText('Still available')).toBeTruthy()}finally{extensionViews['telemetry.v1.Gauge']=original;log.mockRestore()}
})
