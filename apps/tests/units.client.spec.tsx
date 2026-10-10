// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react'
import {afterEach,it,expect,vi} from 'vitest'
import {AppCardRenderer,ResolvedSurface} from '../src/client/renderer.tsx'
import {interactionFixture} from './interaction-fixture.ts'
import {RangeGauge} from '../src/client/range-gauge.tsx'
const renderers:AppCardRenderer[]=[]
afterEach(()=>{cleanup();renderers.splice(0).forEach(r=>r.dispose())})
function mount(component:any,data:any={}){
 const d=interactionFixture();d.data=data;d.ui.surfaces[0].components=[{id:'root',...component}]
 const snapshot:any={machineId:'demo',revision:1,sequence:1,declaration:d,checks:{},actions:{},runs:[]}
 const r=new AppCardRenderer(d,'main',vi.fn(),snapshot);renderers.push(r)
 return render(<ResolvedSurface renderer={r} host={{snapshot,busy:false,invoke:vi.fn(),cancel:vi.fn()}}/> )
}
it.each([['GiB',15.4,16],['%',0,100],['MHz',1312,1530]])('plain Progress displays %s, including zero', (unit,value,max)=>{
 mount({component:'Progress',label:'指标',value,max,unit,accessibility:{label:'读数'}})
 expect(screen.getAllByText(String(value),{exact:false}).some(e=>e.textContent===`${value} / ${max} ${unit}`)).toBe(true)
 expect(screen.getByRole('progressbar',{name:'读数'}).getAttribute('aria-valuetext')).toContain(`${value} / ${max} ${unit}；量程 0–${max}`)
})
it.each([{}, {min:0}, {marker:200}, {colorScale:'thermal'}])('Progress branches preserve bound units %j',extra=>{
 mount({component:'Progress',label:'功耗',value:180,max:300,unit:{path:'/data/unit'},...extra},{unit:'W'})
 expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toContain('180 / 300 W')
})
it('overflow clamps the bar but preserves the actual reading',()=>{
 mount({component:'Progress',label:'利用率',value:120,max:100,unit:'%'})
 expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toContain('120 / 100 %')
 expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
})
it.each([{value:null,max:100},{value:12,max:null},{value:12,max:0},{value:0,max:-1}])('missing/invalid bounds never fabricate a valid reading %j',data=>{
 mount({component:'Progress',label:'指标',value:{path:'/data/value'},max:{path:'/data/max'},unit:'W'},data)
 expect(screen.getByText('暂无观测或有效量程')).toBeTruthy()
 expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
})
it('stale Progress does not expose a current value',()=>{
 mount({component:'Progress',label:'指标',value:10,max:100,unit:'%',fresh:false})
 expect(screen.getByText('观测已过期')).toBeTruthy()
 expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
})
it('Sparkline preserves units and marks expired evidence',()=>{
 mount({component:'Sparkline',label:'频率',values:{path:'/checks/metrics/value/history'},unit:'MHz'})
 expect(screen.getByText('暂无观测 · 已过期')).toBeTruthy()
 expect(screen.getByRole('img').getAttribute('aria-label')).toContain('观测已过期')
})
it.each(['Metric','NumberField','Slider','Sparkline'])('%s displays declared units',component=>{
 mount({component,label:'指标',...(component==='Sparkline'?{values:[0,12]}:{value:12}),...(['NumberField','Slider'].includes(component)?{min:0,max:100}:{}),unit:'MHz'})
 expect(screen.getByText(/MHz/)).toBeTruthy()
})
it('Gauge rejects infinite bounds without printing Infinity',()=>{
 const v=render(<RangeGauge label="功耗" value={20} max={Infinity} unit="W"/>)
 expect(v.container.textContent).not.toContain('Infinity');expect(screen.queryByRole('meter')).toBeNull()
})
