/** Opt-in read-only remote acceptance. No enrolled machines or user paths are built in.
 * Set DSH_REMOTE_ACCEPTANCE=1, DSH_TEST_SSH_CONFIG and DSH_REMOTE_TARGETS_JSON.
 * Targets: [{id, runtime: 'powershell'|'posix', alias, cwd, node,
 * optional probe: {connection, knownHosts, keyType, hostname}}].
 */
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import {executeOperation} from '../src/executor.ts'
import {parseDeclaration} from '../src/declaration.ts'
import {connect} from '../../machines/probe.mjs'
import type {ExecOperation} from '../src/types.ts'

if(process.env.DSH_REMOTE_ACCEPTANCE!=='1')throw new Error('Explicit opt-in required')
const config=process.env.DSH_TEST_SSH_CONFIG
if(!config)throw new Error('DSH_TEST_SSH_CONFIG is required')
const targets=JSON.parse(process.env.DSH_REMOTE_TARGETS_JSON??'[]')
if(!Array.isArray(targets)||targets.length===0)throw new Error('DSH_REMOTE_TARGETS_JSON must contain explicit test targets')
for(const target of targets) {
 if(!['powershell','posix'].includes(target.runtime)||!['id','alias','cwd','node'].every(k=>typeof target[k]==='string'&&target[k].length>0)||!/^[a-z0-9][a-z0-9_.-]*$/i.test(target.alias))throw new Error('Invalid test target')
}
const ctx=new Context();await ctx.plugin(LocalSubprocess)
const payload=`中文 ' " & $() \\ trailing\\\nnext`
try {
 for(const target of targets) {
  const base={kind:'exec',effect:'observe',context:'remote',inputSchema:{type:'object'},timeoutMs:15000,outputLimitBytes:32768,successExitCodes:[0]} as const
  const operations:Record<string,ExecOperation>={
   roundtrip:{...base,program:{kind:'argv',executable:target.node,args:[{literal:'-e'},{literal:'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.CARD_TEST,stdin:s})))'},{literal:''},{literal:payload}]},env:{CARD_TEST:{literal:payload}},stdin:{encoding:'text',value:{literal:payload}},output:{decode:'json',schema:{type:'object'}}},
   exit7:{...base,program:{kind:'argv',executable:target.node,args:[{literal:'-e'},{literal:'process.stderr.write("expected failure");process.exit(7)'}]},output:{decode:'text',schema:{type:'string'}}},
  }
  if(target.runtime==='powershell')operations.ps={...base,program:{kind:'script',interpreter:'powershell.exe',source:'[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write(($args | ConvertTo-Json -Compress))',args:[{literal:payload},{literal:'x'.repeat(2500)}]},output:{decode:'json',schema:{type:'array'}}}
  const declaration=parseDeclaration({apiVersion:'dsh.app-cards/v1',kind:'MachineAppCards',machineId:'test',revision:1,apps:{},data:{},contexts:{remote:{kind:'ssh',pathId:'lan',cwd:target.cwd}},operations,actions:{},checks:{},ui:{a2uiVersion:'0.9.1',catalogId:'urn:dsh:app-cards:catalog:1',surfaces:[]}})
  const env={subprocess:ctx.subprocess,contexts:{remote:{kind:'ssh' as const,cwd:target.cwd,argvPrefix:['ssh','-F',config,target.alias],identity:'readonly-acceptance',display:target.id}},signal:new AbortController().signal,limits:{timeoutMs:15000,outputLimitBytes:32768,graceMs:100,concurrency:1},runAgent:async()=>{throw new Error('No agent allowed')}}
  const roundtrip=await executeOperation(declaration,'roundtrip',{},env)
  assert.equal(roundtrip.state,'succeeded',JSON.stringify(roundtrip));assert.deepEqual(roundtrip.value,{args:['',payload],cwd:target.cwd,env:payload,stdin:payload})
  const failed=await executeOperation(declaration,'exit7',{},env);assert.equal(failed.state,'failed');assert.equal(failed.process?.exitCode,7,JSON.stringify(failed));assert.match(failed.process?.stderr??'',/expected failure/)
  if(target.runtime==='powershell'){const ps=await executeOperation(declaration,'ps',{},env);assert.equal(ps.state,'succeeded',JSON.stringify(ps));assert.deepEqual(ps.value,[payload,'x'.repeat(2500)])}
  console.log('PASS',target.id,'real executor argv / cwd / env / stdin / nonzero exit'+(target.runtime==='powershell'?' / PowerShell script':''))
  if(target.probe){
   const probe=await connect(target.probe.connection,target.alias,target.probe.knownHosts,{type:target.probe.keyType})
   assert.equal(probe.runtime,target.runtime)
   assert.equal(probe.hostname.toLowerCase(),target.probe.hostname.toLowerCase());console.log('PASS',target.id,'pinned connection probe')
  }
 }
} finally {await ctx.fiber.dispose()}
