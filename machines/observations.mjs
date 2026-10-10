import {LibvirtStrategy,LibvirtNetworkObserver} from './lib/observers.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const run=promisify(execFile);
const runner={async run(argv,cwd,signal){
  let result;try{result={...await run(argv[0],argv.slice(1),{cwd,signal,timeout:8000,maxBuffer:256*1024,env:{...process.env,LC_ALL:'C'}}),ok:true,exitCode:0,signal:null};}
  catch(e){result={ok:false,exitCode:typeof e.code==='number'?e.code:null,signal:e.signal??null,stdout:e.stdout??'',stderr:e.stderr??e.message};}
  return {...result,outputHash:createHash('sha256').update(result.stdout+'\0'+result.stderr).digest('hex')};
}};
const options={executable:'/usr/bin/virsh',probeCwd:process.cwd(),maxCollectionItems:24};
const strategy=new LibvirtStrategy(runner,options);
const networks=new LibvirtNetworkObserver(runner,{...options,uri:'qemu:///system'});
export async function observeVM(machine){
  if(machine.locator?.kind!=='libvirt')return null;
  const locator=machine.locator;
  if(locator.uri!=='qemu:///system'||typeof locator.domainName!=='string'||!locator.domainName||locator.domainName.startsWith('-'))throw new Error('Invalid local libvirt locator');
  const result=await strategy.inspect({id:machine.id,displayName:machine.name,kind:'libvirt',descriptor:{strategy:locator}});
  return {...result,observedAt:new Date().toISOString()};
}
export const observeNetworks=()=>networks.observe();
