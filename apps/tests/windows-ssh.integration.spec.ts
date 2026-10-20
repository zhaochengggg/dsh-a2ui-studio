import {Context} from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import {describe,it,expect} from 'vitest'
import {parseDeclaration} from '../src/declaration.ts'
import {executeOperation} from '../src/executor.ts'

// Explicitly opt-in; CI/default tests never contact a user's machine.
const config=process.env.DSH_TEST_SSH_CONFIG
const alias=process.env.DSH_TEST_SSH_ALIAS
describe('Windows host to POSIX target integration',()=>{
 it.skipIf(process.platform!=='win32'||!config||!alias)('runs a read-only SSH card operation through the DSH subprocess service',async()=>{
  const ctx=new Context()
  await ctx.plugin(LocalSubprocess)
  try {
   const document=parseDeclaration({
    apiVersion:'dsh.app-cards/v1',kind:'MachineAppCards',machineId:'acceptance',revision:1,
    apps:{},data:{},contexts:{remote:{kind:'ssh',pathId:'ssh',cwd:'/tmp'}},
    operations:{inspect:{kind:'exec',effect:'observe',context:'remote',inputSchema:{type:'object'},
      program:{kind:'argv',executable:'uname',args:[{literal:'-s'}]},
      output:{decode:'text',schema:{type:'string'}},timeoutMs:5000,outputLimitBytes:4096,successExitCodes:[0]}},
    actions:{},checks:{},ui:{a2uiVersion:'0.9.1',catalogId:'urn:dsh:app-cards:catalog:1',surfaces:[]},
   })
   const result=await executeOperation(document,'inspect',{},{
    subprocess:ctx.subprocess,signal:new AbortController().signal,
    contexts:{remote:{kind:'ssh',cwd:'/tmp',argvPrefix:['ssh','-F',config!,alias!],identity:'test',display:'test'}},
    limits:{timeoutMs:5000,outputLimitBytes:4096,concurrency:1,graceMs:50},
    runAgent:async()=>{throw new Error('No agent in read-only test')},
   })
   expect(result).toMatchObject({state:'succeeded',value:'Linux\n'})
  }finally{await ctx.fiber.dispose()}
 })
})
