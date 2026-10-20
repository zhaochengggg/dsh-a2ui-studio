# v0.3.2 Windows acceptance

Date: 2026-10-20. Host: Windows, DSH Desktop Beta 2.0.18-beta.1,
DSH 0.2.1-rc.2 / Node 24.21.0.

## Actual desktop checks

Installed the prebuilt tarball using the desktop's CLI into its existing desktop
profile, after backing up that profile. The plugin hot-loaded without replacing
the profile or restarting an active conversation.

- Native machine panel opened successfully.
- A temporary machine was registered through the same MachineStore operation
  used by `machine_manage`, with an independently verified host fingerprint.
- Opening the native panel automatically probed that Linux target and showed
  a green connection indicator.
- Machine @ reference insertion and deselection updated the actual conversation
  draft. No message was submitted.
- Dragging the panel boundary resized it and preserved card layout.
- An unpublished, non-executing draft was displayed through the native card
  version selector: current/max values, GiB/MHz units and checkbox alignment
  were visually checked. Preview was explicitly labelled non-live.
- No execution grant was fabricated. Desktop card publication/power-changing
  buttons were not exercised; publication, grants, invocation and revocation
  were tested through the real DSH Loader composition in automated tests.

## Execution and regression

- Windows Node suite: **35 passed**.
- Windows application suite: **221 passed**, two POSIX-only tests skipped.
- Separate opt-in Windows-to-Linux operation test: **1 passed**. The real DSH
  local subprocess service ran an SSH card operation (`uname -s`) through the
  plugin's pinned SSH configuration, returning Linux.
- Explicit Windows PowerShell argv execution passed in the application suite.
- Linux Node regression after the final probe change: **34 passed**, one
  Windows-only test skipped.
- Linux application regression: **222 passed** (before adding the Windows-only
  PowerShell and opt-in SSH test cases; application runtime code was unchanged).

The real connection test found Windows inbox ssh-keyscan's unsupported-KEX bug.
On Windows, standard-location Git OpenSSH keyscan is now preferred when present;
otherwise the inbox error is reported as an algorithm error, not packet loss.
The known fingerprint is still required and checked before pinning or login.

## Scope

Windows-host UI and Windows-to-POSIX SSH are supported. POSIX script operations,
local libvirt and Linux-specific application declarations are not advertised as
native Windows equivalents. See [platform instructions](windows.md).
