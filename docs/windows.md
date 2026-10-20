# Windows desktop

Tested host: Anywhere Labs DSH Desktop Beta **2.0.18-beta.1**, bundled DSH
**0.2.1-rc.2**, Node **24.21.0**. Installation ID remains `dsh-control-studio`.

## Install

Use the desktop distribution's own `dsh` command, not a separate global DSH.
Download the release archive and SHA256SUMS from GitHub. In PowerShell:

```powershell
Invoke-WebRequest https://github.com/zhaochengggg/dsh-a2ui-studio/releases/download/v0.3.2/dsh-control-studio-0.3.2.tgz -OutFile dsh-control-studio-0.3.2.tgz
Invoke-WebRequest https://github.com/zhaochengggg/dsh-a2ui-studio/releases/download/v0.3.2/SHA256SUMS -OutFile SHA256SUMS
$expected = ((Get-Content SHA256SUMS | Where-Object { $_ -match '  dsh-control-studio-0\.3\.2\.tgz$' }) -split '\s+')[0]
if (!$expected -or (Get-FileHash ./dsh-control-studio-0.3.2.tgz -Algorithm SHA256).Hash -ne $expected) { throw 'Checksum mismatch' }
dsh plugin --profile desktop add ./dsh-control-studio-0.3.2.tgz --allow-build=esbuild
```

If `dsh` is not on PATH, use your desktop distribution's documented CLI entry.
Preserve its `DSH_HOME`; Beta and other distributions can use different homes.
Back up the existing profile and plugin data before upgrading.

## Supported and intentionally bounded

- Machine registration, notes/history, @ references and application-card UI
  use the same implementation as Linux.
- Windows-host SSH probes and SSH card operations can target Linux/POSIX hosts.
  Identity files accept drive-qualified paths including spaces; UNC/device paths,
  `%` expansion and SSH configuration control characters are rejected.
- `ssh` must be installed. For key discovery, Git for Windows' keyscan is used
  from its standard Program Files location when present. Otherwise PATH keyscan
  is used. Some inbox Windows keyscan builds advertise an unsupported KEX
  ([upstream issue](https://github.com/PowerShell/Win32-OpenSSH/issues/2140));
  update OpenSSH or install Git for Windows if reported. Fingerprint verification
  is never disabled.
- Local operations use explicit executable/argv with a configured `hostRoots`
  allowlist and reviewed execution permission. Use `powershell.exe`/`pwsh`
  explicitly for Windows commands. POSIX `program.kind: script` declarations
  and Linux commands/paths do not become portable automatically.
- Libvirt network/VM observation requires a Linux host and `virsh`; Windows
  Hyper-V and WSL management are not implemented.
- Dynamic UI extensions are trusted code, with the same explicit installation
  boundary on both platforms.

中文摘要：使用桌面版自己的 CLI/profile 安装；支持 Windows 本机管理界面及连接
Linux 机器。PowerShell 用显式 argv，Linux shell 卡片不能直接照搬。未实现 Windows
Hyper-V/WSL 纳管。不会因兼容性而关闭指纹核验或自动授予卡片执行权限。
