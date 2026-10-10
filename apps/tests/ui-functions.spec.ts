import {expect,it} from 'vitest'
import {uiFunctions,validateUiExpressions} from '../src/ui-functions.ts'
const run=(name:string,args:any)=>uiFunctions.find(f=>f.name===name)!.execute(args,{} as any,new AbortController().signal)
it('handles null arithmetic and preserves zero and false',()=>{
 expect(run('divide',{a:3,b:0})).toBeNull();expect(run('multiply',{a:null,b:3})).toBeNull()
 expect(run('coalesce',{values:[null,false,7]})).toBe(false)
 expect(run('coalesce',{values:[null,0,7]})).toBe(0)
 expect(run('numeric',{value:null,min:0})).toBe(false)
 expect(run('formatNumber',{value:null})).toBe('—')
 expect(run('formatNumber',{value:1.234,decimals:2})).toBe('1.23')
 expect(run('object',{keys:['a','b'],values:[1,false]})).toEqual({a:1,b:false})
})
it('bounds nested expression complexity and rejects literal type errors',()=>{
 let x:any=true;for(let i=0;i<40;i++)x={call:'not',args:{value:x}}
 expect(()=>validateUiExpressions(x)).toThrow('complexity')
 expect(()=>validateUiExpressions({call:'choose',args:{condition:'yes',then:1,else:2}})).toThrow()
})
