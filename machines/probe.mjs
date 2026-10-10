/** Probe evidence and scheduling. Network failures never constitute host-key evidence. */
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export const execute=promisify(execFile);
export const fingerprintOf=key=>'SHA256:'+createHash('sha256').update(Buffer.from(key,'base64')).digest('base64').replace(/=+$/,'');
export function parseKeys(stdout='') {
  return stdout.split('\n').flatMap(line=>{
    const p=line.trim().split(/\s+/);if(p.length<3||line.startsWith('#'))return [];
    try{const b=Buffer.from(p[2],'base64'),n=b.readUInt32BE(0);if(n>100||b.subarray(4,4+n).toString()!==p[1])return [];}catch{return [];}
    return [{type:p[1],key:p[2],fingerprint:fingerprintOf(p[2])}];
  });
}
export function problem(code,message){return Object.assign(new Error(message),{probeCode:code});}
export function classify(error) {
  if(error.probeCode)return {code:error.probeCode,message:error.message};
  const detail=String(error.stderr||(error.killed?'探测超时':error.message)||'').replace(/^Command failed:[^\n]*(\n|$)/,'').trim().slice(0,400);
  if(/REMOTE HOST IDENTIFICATION HAS CHANGED|Offending .* key/i.test(detail))return {code:'identity_conflict',message:'机器身份有变化；已阻断连接。\n'+detail};
  if(/no matching host key type|no matching key exchange|no matching cipher/i.test(detail))return {code:'algorithm_unavailable',message:'无法用登记的算法验证机器身份。\n'+detail};
  if(/Host key verification failed|No .* host key is known/i.test(detail))return {code:'identity_unverified',message:'机器身份核验未通过；已阻断连接。\n'+detail};
  if(/Permission denied|Authentication failed|Too many authentication/i.test(detail))return {code:'auth_failed',message:'登录被拒绝；请检查账号和登录密钥。\n'+detail};
  if(error.killed||/timed out|timeout|Connection reset|Connection closed|Connection refused|No route to host|Network is unreachable|Connection timed/i.test(detail))return {code:'network_failed',message:'连接失败（超时或网络错误）。\n'+detail};
  return {code:'probe_error',message:'探测未完成。\n'+detail};
}
export async function discover(c,{run=execute,deadline=Date.now()+7000,scanMs=3000}={}) {
  const abort=new AbortController(),evidence={};let found;
  const tasks=['ed25519','rsa','ecdsa'].map(async type=>{
    for(let attempt=1;attempt<=2&&!abort.signal.aborted;attempt++){
      const remaining=deadline-Date.now();if(remaining<100)break;
      let out='';try{out=(await run('ssh-keyscan',['-T',String(Math.max(1,Math.ceil(Math.min(scanMs,remaining)/1000))),'-t',type,'-p',String(c.port),c.host],{signal:abort.signal,timeout:Math.min(scanMs+100,remaining),maxBuffer:65536,env:{...process.env,LC_ALL:'C'}})).stdout;}catch(e){out=e.stdout||'';}
      if(abort.signal.aborted)return;
      const keys=parseKeys(out);evidence[type]={attempts:attempt,result:keys.length?'different':'missing'};
      const match=keys.find(k=>k.fingerprint===c.fingerprint.replace(/=+$/,''));
      if(match){found=match;abort.abort();return;}
      if(keys.length)return; // Only missing evidence is retried.
    }
  });
  await Promise.all(tasks);
  if(found)return {key:found,evidence};
  const complete=Object.values(evidence).length===3&&Object.values(evidence).every(e=>e.result==='different');
  const error=problem(complete?'identity_conflict':'identity_incomplete',complete?'已取得三类主机密钥，但均不符合登记指纹；已阻断连接。':'未取得足够的主机密钥证据，身份核验未完成；未将超时判成指纹不匹配。');
  error.evidence=evidence;throw error;
}
export function hostAlgorithms(type){
  if(type==='ssh-rsa')return 'rsa-sha2-512,rsa-sha2-256';
  if(type==='ssh-ed25519'||/^ecdsa-sha2-nistp(256|384|521)$/.test(type))return type;
  throw problem('algorithm_unavailable','登记的主机密钥类型不受此探测器支持。');
}
export async function connect(c,alias,knownHosts,key,{run=execute,deadline=Date.now()+10000,attemptMs=4800}={}){
  for(let attempt=1;attempt<=2;attempt++){
    const remaining=deadline-Date.now();if(remaining<100)throw problem('network_failed','连接探测已达到总时间上限。');
    const budget=Math.min(attemptMs,remaining);
    const options={HostName:c.host,Port:c.port,User:c.user,HostKeyAlias:alias,UserKnownHostsFile:knownHosts,GlobalKnownHostsFile:'/dev/null',StrictHostKeyChecking:'yes',UpdateHostKeys:'no',BatchMode:'yes',ControlMaster:'no',ControlPath:'none',ForwardAgent:'no',ForwardX11:'no',ClearAllForwardings:'yes',PermitLocalCommand:'no',ProxyCommand:'none',ProxyJump:'none',PasswordAuthentication:'no',KbdInteractiveAuthentication:'no',ConnectionAttempts:1,ConnectTimeout:Math.max(1,Math.ceil(budget/1000)),HostKeyAlgorithms:hostAlgorithms(key.type)};
    if(c.identityFile){options.IdentityFile=c.identityFile;options.IdentitiesOnly='yes';}
    const args=['-F','/dev/null',...Object.entries(options).flatMap(([k,v])=>['-o',`${k}=${v}`]),alias,'printf "DSH_MACHINE_OK\\n"; hostname'];
    try{const r=await run('ssh',args,{timeout:budget,maxBuffer:8192,env:{...process.env,LC_ALL:'C'}});
      if(!r.stdout.startsWith('DSH_MACHINE_OK\n'))throw problem('probe_error','SSH 已响应，但探测命令返回格式异常。');
      return {hostname:r.stdout.split('\n')[1],attempts:attempt};
    }catch(e){if(attempt===2||classify(e).code!=='network_failed'||deadline-Date.now()<100){e.attempts=attempt;throw e;}}
  }
}
// Bound all callers, including tools, not only the browser's refresh queue.
let active=0;const queue=[];
export async function limited(fn){if(active>=4)await new Promise(resolve=>queue.push(resolve));else active++;try{return await fn();}finally{const next=queue.shift();if(next)next();else active--;}}
