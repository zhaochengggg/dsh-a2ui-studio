// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {AppCardRenderer,ResolvedSurface} from '../src/client/renderer.tsx'
import {interactionFixture,call,path} from './interaction-fixture.ts'
import {validateUi} from '../src/ui-catalog.ts'
const rs:AppCardRenderer[]=[]
afterEach(()=>{cleanup();rs.splice(0).forEach(r=>r.dispose())})
function setup(doc=interactionFixture()){const action=vi.fn(),r=new AppCardRenderer(doc,'main',action);rs.push(r);render(<ResolvedSurface renderer={r}/>);return {r,action}}
const submit=async()=>{fireEvent.click(screen.getByRole('button',{name:'应用（模拟）'}));await act(async()=>{await Promise.resolve()})}
it('uses natural sync checkbox, preserves independent drafts, and resolves effective values at click time',async()=>{
 const {action}=setup()
 expect(screen.queryByLabelText('GPU 1（W）')).toBeNull()
 await submit();expect(action.mock.lastCall?.[0].context.input).toEqual({gpu0:200,gpu1:200})
 fireEvent.click(screen.getByLabelText('同时设置两卡'))
 fireEvent.change(screen.getByLabelText('GPU 1（W）'),{target:{value:'175'}})
 await submit();expect(action.mock.lastCall?.[0].context.input).toEqual({gpu0:200,gpu1:175})
 fireEvent.click(screen.getByLabelText('同时设置两卡'))
 fireEvent.change(screen.getByLabelText('两卡功耗上限（W）'),{target:{value:'210'}})
 await submit();expect(action.mock.lastCall?.[0].context.input).toEqual({gpu0:210,gpu1:210})
 fireEvent.click(screen.getByLabelText('同时设置两卡'))
 expect((screen.getByLabelText('GPU 1（W）') as HTMLInputElement).value).toBe('175')
 expect(screen.getByText('将提交：GPU 0 · 200 W / GPU 1 · 175 W')).toBeTruthy()
})
it('blocks invalid visible input, accepts hidden invalid drafts, and never turns an empty input into zero',async()=>{
 const {action}=setup()
 const button=()=>screen.getByRole('button',{name:'应用（模拟）'}) as HTMLButtonElement
 fireEvent.change(screen.getByLabelText('两卡功耗上限（W）'),{target:{value:'300'}})
 expect(button().disabled).toBe(true);expect(screen.getByText('不能大于 250')).toBeTruthy()
 await submit();expect(action).not.toHaveBeenCalled()
 fireEvent.change(screen.getByLabelText('两卡功耗上限（W）'),{target:{value:''}})
 expect(button().disabled).toBe(true);expect(screen.getByText('请输入有效数字')).toBeTruthy()
 fireEvent.click(screen.getByLabelText('同时设置两卡'))
 expect(button().disabled).toBe(false)
 await submit();expect(action.mock.lastCall?.[0].context.input).toEqual({gpu0:200,gpu1:180})
 fireEvent.click(screen.getByLabelText('同时设置两卡'));expect(button().disabled).toBe(true)
})
it('reactively applies explicit checks and dynamic disabled and preserves draft during data refresh',()=>{
 const d=interactionFixture(),cs=d.ui.surfaces[0]!.components as any[]
 cs.find(c=>c.id==='shared').checks=[{condition:call('less_than',{a:path('/form/shared'),b:220}),message:'模拟散热限额：须低于 220 W'}]
 cs.find(c=>c.id==='apply').disabled=call('equals',{a:path('/form/shared'),b:205})
 const {r}=setup(d),input=screen.getByLabelText('两卡功耗上限（W）')
 fireEvent.change(input,{target:{value:'225'}})
 expect(screen.getByText('模拟散热限额：须低于 220 W')).toBeTruthy()
 expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
 fireEvent.change(input,{target:{value:'205'}})
 expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
 fireEvent.change(input,{target:{value:'210'}})
 act(()=>r.process([{version:'v0.9.1',updateDataModel:{surfaceId:'main',path:'/checks',value:{}}}]))
 expect((input as HTMLInputElement).value).toBe('210');expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false)
})
it.each([call('eval',{code:'1'}),call('not',{}),call('choose',{condition:true,then:1}),call('not',{value:path('/form/__proto__/x')}),call('numeric',{value:1,typo:2})])('rejects unsupported/malformed expressions %j',expression=>{
 const d=interactionFixture();(d.ui.surfaces[0]!.components[0] as any).visible=expression
 expect(()=>validateUi(d)).toThrow()
})
