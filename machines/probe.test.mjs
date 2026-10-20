import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {discover,connect as connectRaw,parseKeys,fingerprintOf,classify} from './probe.mjs';
const connect=(c,alias,known,key,options)=>connectRaw(c,alias,path.resolve(known),key,options);
import {MachineStore} from './store.mjs';
import {connectionStatus,probeTooltip} from './controller.mjs';
function key(type,content='test'){const n=Buffer.alloc(4);n.writeUInt32BE(type.length);return Buffer.concat([n,Buffer.from(type),Buffer.from(content)]).toString('base64');}
const good=key('ssh-ed25519'),bad=key('ssh-ed25519','other');
const c={id:'lan',host:'192.0.2.1',port:22,user:'root',fingerprint:fingerprintOf(good)};
test('client algorithm defects are not reported as missing network evidence',async()=>{
 await assert.rejects(discover(c,{run:async()=>{throw Object.assign(new Error('unsupported KEX'),{probeCode:'algorithm_unavailable'});}}),
 e=>e.probeCode==='algorithm_unavailable');
});
test('missing registered type plus other nonmatches is incomplete, not mismatch; retries only missing',async()=>{
  const calls={};const run=async(_,args)=>{const t=args[args.indexOf('-t')+1];calls[t]=(calls[t]||0)+1;return {stdout:t==='ed25519'?'':`host ssh-${t} ${key('ssh-'+t)}\n`};};
  await assert.rejects(discover(c,{run}),e=>e.probeCode==='identity_incomplete');assert.deepEqual(calls,{ed25519:2,rsa:1,ecdsa:1});
});
test('all different is identity conflict, no missing-key retries',async()=>{
  let count=0;await assert.rejects(discover(c,{run:async()=>{count++;return {stdout:`h ssh-ed25519 ${bad}`};}}),e=>e.probeCode==='identity_conflict');assert.equal(count,3);
});
test('parallel discovery returns match and cancels stalled scans',async()=>{
  let aborted=0;const start=Date.now();const r=await discover(c,{run:async(_,args,opts)=>{
    const type=args[args.indexOf('-t')+1];if(type==='ed25519'){await new Promise(r=>setTimeout(r,15));return {stdout:`h ssh-ed25519 ${good}`};}
    return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>{aborted++;reject(new Error('aborted'));},{once:true}));
  }});assert.equal(r.key.fingerprint,c.fingerprint);assert.equal(aborted,2);assert.ok(Date.now()-start<1000);
});
test('six missing scans use two concurrent waves, bounded deadline',async()=>{
  let active=0,peak=0,count=0;const start=Date.now();await assert.rejects(discover(c,{scanMs:10,deadline:start+500,run:async()=>{count++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;return {stdout:''};}}),e=>e.probeCode==='identity_incomplete');assert.equal(count,6);assert.equal(peak,3);assert.ok(Date.now()-start<400);
});
test('strict pinned path only uses ssh; retry transient network error',async()=>{
  let count=0;const r=await connect(c,'alias','/tmp/pin',{type:'ssh-ed25519'},{run:async(cmd,args)=>{count++;assert.equal(cmd,'ssh');for(const value of ['StrictHostKeyChecking=yes','UpdateHostKeys=no','ControlPath=none','HostKeyAlgorithms=ssh-ed25519'])assert.ok(args.includes(value));if(count===1)throw Object.assign(new Error('failed'),{stderr:'Connection timed out'});return {stdout:'DSH_MACHINE_OK\nhost\n'};}});assert.equal(r.attempts,2);
});
for(const [stderr,code] of [['REMOTE HOST IDENTIFICATION HAS CHANGED','identity_conflict'],['Permission denied (publickey).','auth_failed'],['no matching host key type found','algorithm_unavailable']])test(code+' does not retry',async()=>{
  let count=0;await assert.rejects(connect(c,'a','/tmp/p',{type:'ssh-ed25519'},{run:async()=>{count++;throw {stderr};}}),e=>classify(e).code===code);assert.equal(count,1);
});
test('attempt timeouts obey remaining overall budget',async()=>{
  let count=0;await assert.rejects(connect(c,'a','/tmp/p',{type:'ssh-rsa'},{deadline:Date.now()+200,attemptMs:150,run:async(_,args,opts)=>{count++;assert.ok(opts.timeout<=200);assert.ok(args.includes('HostKeyAlgorithms=rsa-sha2-512,rsa-sha2-256'));await new Promise(r=>setTimeout(r,120));throw {killed:true};}}));assert.equal(count,1);
});
test('malformed scanned key ignored',()=>assert.deepEqual(parseKeys('h ssh-ed25519 AAAA'),[]));
test('all failures map red; null gray; tooltip contains details only',()=>{
  assert.equal(connectionStatus(null),'unknown');for(const code of ['auth_failed','identity_conflict','network_failed','identity_missing'])assert.equal(connectionStatus({status:'unreachable',code}),'attention');assert.match(probeTooltip({status:'unreachable',message:'登录被拒绝'},true),/正在检测.*\n上次结果：连接失败\n登录被拒绝/);
});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'probe-tests-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const s=new MachineStore(path.join(root,'machines'),path.join(root,'ssh'));await s.manage({action:'create',machine_id:'x',machine:{name:'x',connections:[c]}});return s;}
test('duplicate probes coalesce and preserve last success on later failure',async t=>{
  const s=await fixture(t);let calls=0;s.probeConnection=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {status:'reachable',observedAt:'2026-10-09T00:00:00Z'};};const m=(await s.load('x')).machine,conn=m.connections[0];await Promise.all([s.probe(m,conn),s.probe(m,conn)]);assert.equal(calls,1);s.probeConnection=async()=>({status:'unreachable',observedAt:'2026-10-09T01:00:00Z'});const r=await s.probe(m,conn);assert.equal(r.lastSuccessAt,'2026-10-09T00:00:00Z');
});
test('changed endpoint discards in-flight result',async t=>{
  const s=await fixture(t),d=await s.load('x');let release,started;const ready=new Promise(r=>started=r);s.probeConnection=async()=>{started();await new Promise(r=>release=r);return {status:'reachable'};};const pending=s.probe(d.machine,d.machine.connections[0]);await ready;await s.manage({action:'update',machine_id:'x',revision:d.revision,machine:{connections:[{...c,host:'192.0.2.2'}]}});release();await assert.rejects(pending,/配置已变化/);assert.equal(s.observations.size,0);
});
test('pin inconsistent with declaration fails locally, does not scan or overwrite',async t=>{
  const s=await fixture(t),m=(await s.load('x')).machine;const file=path.join(s.sshDir,'known_hosts'),content=`dsh-x-lan ssh-ed25519 ${bad}\n`;await fs.writeFile(file,content);const r=await s.probe(m,m.connections[0]);assert.equal(r.code,'pin_conflict');assert.equal(await fs.readFile(file,'utf8'),content);
});
