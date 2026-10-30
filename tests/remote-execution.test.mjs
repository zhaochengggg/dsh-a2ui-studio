import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectRemote,remoteInvocation,remoteCompletion,scriptArgv,parseProbe} from '../shared/remote-execution.mjs';
const exec=promisify(execFile);
test('discovery falls back only for command incompatibility, supports CRLF',async()=>{
 let count=0;assert.deepEqual(await detectRemote(async()=>{if(++count===1)throw {code:127};return {stdout:'DSH_MACHINE_OK\r\n桌面\r\n'};}),{runtime:'powershell',hostname:'桌面'});
 assert.equal(count,2);assert.equal(parseProbe('banner\nDSH_MACHINE_OK\nhost'),null);
});
test('identity, authentication and timeout errors never trigger shell fallback',async()=>{
 for(const e of [{code:255},{killed:true},{probeCode:'identity_conflict'}]){let count=0;await assert.rejects(detectRemote(async()=>{count++;throw e;}));assert.equal(count,1);}
});
test('authenticated execution error is not network unreachable',async()=>{
 await assert.rejects(detectRemote(async()=>({stdout:'not a probe'})),e=>e.probeCode==='execution_failed'&&e.sshAuthenticated===true);
});
test('unsupported runtime and NUL arguments are rejected',()=>{
 assert.throws(()=>remoteInvocation('unknown',{cwd:'/',argv:['true']}));
 assert.throws(()=>remoteInvocation('posix',{cwd:'/',argv:['echo','\0']}));
 for(const executable of ['cmd.exe','C:\\Windows\\System32\\cmd.exe','job.cmd','job.BAT'])assert.throws(()=>remoteInvocation('powershell',{cwd:'C:\\',argv:[executable]}),/literal argv/);
});
test('large payload crosses cmd entrance without enlarging launcher or losing stdin',{skip:process.platform!=='win32'},async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'remote-long-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const argument='中文"\\'.repeat(1000);
 const wire=remoteInvocation('powershell',{cwd,argv:[process.execPath,'-e','let s="";process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>console.log(JSON.stringify({arg:process.argv[1],stdin:s})))',argument],stdin:'payload\nrest'});
 const child=execFile('cmd.exe',['/d','/s','/c',wire.command],{encoding:'utf8',timeout:10000,windowsHide:true,windowsVerbatimArguments:true},()=>{});
 const result=new Promise((resolve,reject)=>{let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',code=>resolve({stdout,stderr,code}));});
 child.stdin.end(wire.stdin);const r=await result;assert.equal(r.code,0,r.stderr);assert.deepEqual(JSON.parse(remoteCompletion(wire.completionMarker,r.stdout).stdout),{arg:argument,stdin:'payload\nrest'});
});
function decode(command){return Buffer.from(command.split(' ').at(-1),'base64').toString('utf16le');}
test('Windows wire command contains only fixed flags and base64',()=>{
 const {command}=remoteInvocation('powershell',{cwd:"C:\\目录 ' &",argv:['node.exe',`" & exit 99; '`, ''],env:{X:'$env:PATH'}});
 assert.match(command,/^powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [\w+/=]+$/);
 assert.match(decode(command),/scriptblock/);
 assert.ok(command.length<8000,'fixed launcher fits cmd.exe');
});
test('Windows actual argv, UTF8 stdin, cwd and env round-trip without shell interpretation',{skip:process.platform!=='win32'},async t=>{
 const cwd=await mkdtemp(join(tmpdir(),"卡片 空格'"));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const args=['','中文','a b','"quoted"',"' ; & $() `test`",'trailing\\','a\\"b','line\nbreak'];
 const source='let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>{console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.CARD_VALUE,stdin:s}));console.error("stderr中文")})';
 const wire=remoteInvocation('powershell',{cwd,argv:[process.execPath,'-e',source,...args],env:{CARD_VALUE:'中文 " $ &'},stdin:'输入\n$()'});
 const child=execFile('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',wire.command.split(' ').at(-1)],{encoding:'utf8',timeout:10000,windowsHide:true},()=>{});
 const result=new Promise((resolve,reject)=>{let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',code=>resolve({stdout,stderr,code}));});
 child.stdin.end(wire.stdin);const r=await result;
 assert.equal(r.code,0,r.stderr);assert.deepEqual(JSON.parse(remoteCompletion(wire.completionMarker,r.stdout).stdout),{args,cwd,env:'中文 " $ &',stdin:'输入\n$()'});assert.match(r.stderr,/stderr中文/);
});
test('PowerShell scripts accept literal positional args and preserve failure exit',{skip:process.platform!=='win32'},async()=>{
 for(const code of [0,7]){
  const argv=scriptArgv('powershell.exe',`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write($args[0]); exit ${code}`,[`中文 ' $ &`]);
  try{const r=await exec(argv[0],argv.slice(1),{encoding:'utf8',windowsHide:true});assert.equal(code,0);assert.equal(r.stdout,`中文 ' $ &`);}
  catch(e){assert.equal(e.code,code);assert.equal(e.stdout,`中文 ' $ &`);}
 }
});
test('Windows executable lookup honors the requested PATH and cwd',{skip:process.platform!=='win32'},async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'remote-path-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 for(const [executable,PATH,success] of [['node.exe','',false],['node.exe',join(process.execPath,'..'),true],[process.execPath,'',true]]){
  const wire=remoteInvocation('powershell',{cwd,argv:[executable,'-e','process.stdout.write("ok")'],env:{PATH}});
  const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',wire.command.split(' ').at(-1)],{encoding:'utf8',timeout:10000,windowsHide:true},()=>{});
  const result=new Promise((resolve,reject)=>{let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',code=>resolve({stdout,stderr,code}));});
  child.stdin.end(wire.stdin);const r=await result;const done=remoteCompletion(wire.completionMarker,r.stdout);assert.equal(done.exitCode,success?0:1,r.stderr);if(success)assert.equal(done.stdout,'ok');else assert.match(r.stderr,/Executable not found/);
 }
 const wire=remoteInvocation('powershell',{cwd:join(process.execPath,'..'),argv:['.\\node.exe','-e','process.stdout.write("relative")'],env:{PATH:''}});
 const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',wire.command.split(' ').at(-1)],{encoding:'utf8',timeout:10000,windowsHide:true},()=>{});
 let stdout='';child.stdout.on('data',x=>stdout+=x);child.stdin.end(wire.stdin);const code=await new Promise(r=>child.on('close',r));assert.equal(code,0);assert.equal(remoteCompletion(wire.completionMarker,stdout).stdout,'relative');
});
test('completion requires the per-run exact tail and retains all application output',()=>{
 assert.deepEqual(remoteCompletion('unique:','hello\n\nunique:7\n'),{stdout:'hello\n',exitCode:7});
 for(const output of ['hello','\nother:0\n','\nunique:0\nextra','\nunique:NaN\n'])assert.equal(remoteCompletion('unique:',output),null);
});
