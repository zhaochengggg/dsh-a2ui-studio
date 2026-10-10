import type {CardDeclaration} from '../src/types.ts'
export const path=(path:string)=>({path})
export const call=(call:string,args:Record<string,any>)=>({call,args})
export function interactionFixture():CardDeclaration{
 const sync=path('/form/sync'),separate=call('not',{value:sync})
 const selected=(gpu:string)=>call('choose',{condition:sync,then:path('/form/shared'),else:path('/form/'+gpu)})
 return {apiVersion:'dsh.app-cards/v1',kind:'MachineAppCards',machineId:'demo',revision:1,apps:{gpu:{name:'双卡功耗'}},contexts:{},operations:{},data:{},checks:{},actions:{apply:{appId:'gpu',label:'应用',operation:'apply',input:{literal:{}},availability:{kind:'always'},invalidates:[]}},ui:{a2uiVersion:'0.9.1',catalogId:'urn:dsh:app-cards:catalog:1',surfaces:[{id:'main',appId:'gpu',order:0,formInitial:{sync:true,shared:200,gpu0:200,gpu1:180},components:[
  {id:'root',component:'Card',child:'fields'},
  {id:'fields',component:'Column',children:['title','sync','shared','separate','effective','apply']},
  {id:'title',component:'Text',text:'功耗设置',variant:'h3'},
  {id:'sync',component:'CheckBox',label:'同时设置两卡',value:sync},
  {id:'shared',component:'NumberField',label:'两卡功耗上限（W）',value:path('/form/shared'),min:100,max:250,step:5,visible:sync},
  {id:'separate',component:'Row',children:['gpu0','gpu1'],visible:separate},
  {id:'gpu0',component:'NumberField',label:'GPU 0（W）',value:path('/form/gpu0'),min:100,max:250,step:5},
  {id:'gpu1',component:'NumberField',label:'GPU 1（W）',value:path('/form/gpu1'),min:100,max:250,step:5},
  {id:'effective',component:'Text',text:call('concat',{values:['将提交：GPU 0 · ',selected('gpu0'),' W / GPU 1 · ',selected('gpu1'),' W']})},
  {id:'apply',component:'Button',child:'apply-label',action:{event:{name:'app.invoke',context:{actionId:'apply',input:{gpu0:selected('gpu0'),gpu1:selected('gpu1')}}}}},
  {id:'apply-label',component:'Text',text:'应用（模拟）'},
 ]}]}} as CardDeclaration
}
