// @vitest-environment jsdom
import {cleanup,render,screen,fireEvent} from '@testing-library/react'
import {afterEach,it,expect,vi} from 'vitest'
import {AppCardRenderer,ResolvedSurface} from '../src/client/renderer.tsx'
import {interactionFixture} from './interaction-fixture.ts'
const rs:AppCardRenderer[]=[]
afterEach(()=>{cleanup();rs.splice(0).forEach(r=>r.dispose())})
function view(component:string,extra:any={}){
 const d=interactionFixture();d.ui.surfaces[0].components=[{id:'root',component,label:'功耗',value:210,max:300,unit:'W',...extra}]
 const r=new AppCardRenderer(d,'main',vi.fn());rs.push(r);return render(<ResolvedSurface renderer={r}/> )
}
it.each(['Progress','telemetry.v1.Gauge'])('%s shares inline value/max and has no legend or disclosure',component=>{
 const v=view(component,{marker:200});expect(v.container.querySelector('[data-compact=true]')).toBeTruthy()
 expect(v.container.querySelector('details')).toBeNull()
 expect(screen.queryByText('量程')).toBeNull()
 expect(v.container.textContent).toBe('功耗210 / 300 W')
 expect(v.container.querySelector('[title="设定值 200 W"]')).toBeTruthy()
 expect(v.container.querySelector('[aria-valuenow]')?.getAttribute('aria-valuenow')).toBe('210')
})
it('min, marker and colorScale do not change Progress layout',()=>{
 const structure=(extra:any)=>{const v=view('Progress',extra);const s=[...v.container.querySelectorAll('*')].map(e=>e.tagName+':'+e.className).filter(s=>!s.includes('gaugeMarker'));cleanup();return s}
 expect(structure({min:0,colorScale:'thermal'})).toEqual(structure({}))
})
it.each(['Progress','telemetry.v1.Gauge'])('%s detailed spacing does not restore lower text',component=>{
 const v=view(component,{variant:'detailed'});expect(v.container.querySelector('details')).toBeNull();expect(v.container.textContent).toBe('功耗210 / 300 W')
})
