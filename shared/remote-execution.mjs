/** Remote shell adaptation. Discovery is read-only; application commands are never retried. */
import {randomBytes} from 'node:crypto';
export const posixProbe = 'printf "DSH_MACHINE_OK\\n"; hostname';
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
export function encodedPowerShell(source) {
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(source, 'utf16le').toString('base64');
}
export const windowsProbe = encodedPowerShell("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::WriteLine('DSH_MACHINE_OK'); [Console]::WriteLine([Environment]::MachineName)");
export function parseProbe(stdout) {
  const lines = String(stdout).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split('\n');
  return lines[0] === 'DSH_MACHINE_OK' && lines[1]?.trim() ? lines[1].trim() : null;
}
export async function detectRemote(run) {
  let authenticated = false;
  for (const [runtime, command] of [['posix', posixProbe], ['powershell', windowsProbe]]) {
    let result;
    try { result = await run(command); }
    catch (error) {
      // SSH transport/authentication failures must not be hidden by another shell attempt.
      if (error.code === 255 || error.killed || error.signal || error.probeCode || typeof error.code !== 'number') throw error;
      authenticated = true;
      continue;
    }
    authenticated = true;
    const hostname = parseProbe(result.stdout);
    if (hostname) return {runtime, hostname};
  }
  throw Object.assign(new Error('SSH 已连接，但远端命令环境检查失败；未修改默认 shell。'), {probeCode:'execution_failed', sshAuthenticated:authenticated});
}
export function quotePosix(value) {
  if (value.includes('\0')) throw new Error('Remote arguments cannot contain NUL');
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function scriptArgv(interpreter, source, args) {
  const name = interpreter.split(/[\\/]/).at(-1).toLowerCase();
  if (/^(?:sh|bash|dash|ksh|zsh)$/.test(name)) return [interpreter, '-c', source, 'app-cards', ...args];
  if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(name)) {
    const body = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; $global:LASTEXITCODE=0; $cardArgs=@(" + args.map(psQuote).join(',') + '); & {\n' + source + '\n} @cardArgs; exit $LASTEXITCODE';
    return [interpreter, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')];
  }
  throw Object.assign(new Error('Script programs require a POSIX shell or PowerShell; other interpreters must use explicit argv'), {code:'INTERPRETER_UNSUPPORTED'});
}
export function remoteInvocation(runtime, {cwd, argv, env = {}, stdin}) {
  for (const value of [cwd, ...argv, ...Object.keys(env), ...Object.values(env)]) if (value.includes('\0')) throw new Error('Remote values cannot contain NUL');
  if (runtime === 'posix') return {command:`cd ${quotePosix(cwd)} && exec env ${Object.entries(env).map(([k,v])=>quotePosix(`${k}=${v}`)).join(' ')} ${argv.map(quotePosix).join(' ')}`,stdin};
  if (runtime !== 'powershell') throw new Error('Unknown remote runtime');
  if (/^(?:cmd)(?:\.exe)?$/i.test(argv[0].split(/[\\/]/).at(-1)) || /\.(?:cmd|bat)$/i.test(argv[0])) {
    throw new Error('cmd.exe and batch files do not preserve literal argv; use a PowerShell script or an explicit native executable');
  }
  // Use CreateProcess argument quoting, not PowerShell's lossy native argv conversion (5.1).
  // Streams are copied as bytes, avoiding code-page re-encoding and CLIXML wrappers.
  const bootstrap = String.raw`function Quote-Arg([string]$s) {
  $b = [Text.StringBuilder]::new(); [void]$b.Append('"'); $slashes=0
  foreach($ch in $s.ToCharArray()) {
    if($ch -eq '\') { $slashes++; continue }
    if($ch -eq '"') { [void]$b.Append(('\' * (2*$slashes+1))); [void]$b.Append('"') }
    else { [void]$b.Append(('\' * $slashes)); [void]$b.Append($ch) }
    $slashes=0
  }
  [void]$b.Append(('\' * (2*$slashes))); [void]$b.Append('"'); $b.ToString()
}
function Complete-Remote([int]$code) {
  [Console]::Out.Write(([char]10)+$request.marker+$code+([char]10)); exit 0
}
try {
  $p = New-Object Diagnostics.Process
  $p.StartInfo = New-Object Diagnostics.ProcessStartInfo
  $p.StartInfo.UseShellExecute = $false
  $p.StartInfo.FileName = $request.argv[0]
  $p.StartInfo.WorkingDirectory = $request.cwd
  $p.StartInfo.Arguments = (@($request.argv | Select-Object -Skip 1) | ForEach-Object { Quote-Arg $_ }) -join ' '
  if(($p.StartInfo.FileName.Length+$p.StartInfo.Arguments.Length) -gt 32000) { throw 'Remote child command exceeds Windows argument limit' }
  foreach($item in $request.env.PSObject.Properties) { $p.StartInfo.EnvironmentVariables[$item.Name]=[string]$item.Value }
  $name=$p.StartInfo.FileName
  if(-not [IO.Path]::IsPathRooted($name)) {
    $names=@($name); if(-not [IO.Path]::GetExtension($name)) { $names=@($name+'.exe',$name+'.com') }
    $dirs=@($request.cwd)
    if($name -notmatch '[\\/]') { $dirs+=@($p.StartInfo.EnvironmentVariables['PATH'] -split ';' | Where-Object { $_ }) }
    $resolved=$null
    foreach($dir in $dirs) {
      if(-not [IO.Path]::IsPathRooted($dir)) { $dir=Join-Path $request.cwd $dir }
      foreach($candidate in $names) { $file=Join-Path $dir $candidate; if(Test-Path -LiteralPath $file -PathType Leaf) { $resolved=[IO.Path]::GetFullPath($file); break } }
      if($resolved) { break }
    }
    if(-not $resolved) { throw 'Executable not found in the requested working directory or PATH' }
    if($resolved -match '\.(cmd|bat)$') { throw 'Batch programs do not preserve literal argv; use PowerShell script' }
    $p.StartInfo.FileName=$resolved
  }
  $p.StartInfo.RedirectStandardInput = $true
  $p.StartInfo.RedirectStandardOutput = $true
  $p.StartInfo.RedirectStandardError = $true
  [void]$p.Start()
  $out = $p.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $err = $p.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  $inputCopy = $inputStream.CopyToAsync($p.StandardInput.BaseStream)
  try { [void]$inputCopy.GetAwaiter().GetResult() } catch {} finally { try { $p.StandardInput.Close() } catch {} }
  $p.WaitForExit(); [void]$out.GetAwaiter().GetResult(); [void]$err.GetAwaiter().GetResult()
  Complete-Remote $p.ExitCode
} catch { [Console]::Error.WriteLine($_.Exception.Message); Complete-Remote 1 }`;
  // The fixed launcher is independent of code/argument size, including the trusted adapter.
  const command = encodedPowerShell(String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
try {
  $inputStream=[Console]::OpenStandardInput(); $header=[Text.StringBuilder]::new()
  while(($byte=$inputStream.ReadByte()) -ne 10) {
    if($byte -lt 0 -or $header.Length -ge 2097152) { throw 'Invalid remote execution header' }
    [void]$header.Append([char]$byte)
  }
  $request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($header.ToString())) | ConvertFrom-Json
  & ([scriptblock]::Create($request.bootstrap))
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`);
  const completionMarker='DSH_EXIT_'+randomBytes(16).toString('hex')+':';
  const header = Buffer.from(JSON.stringify({bootstrap,cwd,argv,env,marker:completionMarker}),'utf8').toString('base64');
  if(header.length>2097152)throw new Error('Remote execution header is too large');
  return {command,stdin:header+'\n'+(stdin??''),completionMarker};
}
/** The outer Windows SSH shell may normalize all native failures to 1. Keep actual completion. */
export function remoteCompletion(marker, stdout) {
  const end=stdout.endsWith('\r\n')?2:stdout.endsWith('\n')?1:0;
  if(!end)return null;
  const at=stdout.lastIndexOf('\n'+marker);
  if(at<0)return null;
  const number=stdout.slice(at+1+marker.length,-end);
  if(!/^-?\d{1,10}$/.test(number))return null;
  return {stdout:stdout.slice(0,at),exitCode:Number(number)};
}
