# Optional systemd preparation example

Use this only after selecting an existing compatible systemd manager. It is an administrator-owned deployment example, not installation instructions for every machine and not a card action. The [complete card](service-card.md) assumes this preparation; it does not perform it.

## Persistent system service

Assume a dedicated low-privilege `demo` account and an immutable application release at `/srv/demo/releases/r1/`. The application runs in the foreground and is already configured to answer the example's loopback HTTP endpoint. Confirm its real command, dependencies, working directory, and readiness protocol; do not invent flags. Transfer ownership of any old instance deliberately: installing a unit does not adopt an existing background process or free its port.

Example `/etc/systemd/system/demo.service`:

```ini
[Unit]
Description=Managed demo service
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
User=demo
Group=demo
WorkingDirectory=/srv/demo/releases/r1
ExecStart=/usr/bin/python3 -u /srv/demo/releases/r1/server.py
Restart=on-failure
RestartSec=2s
TimeoutStartSec=20s
TimeoutStopSec=20s
KillMode=control-group
StandardInput=null
StandardOutput=journal
StandardError=journal
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

The manager owns descendants, termination, and logs; do not add `nohup`, shell backgrounding, or a pattern-based `ExecStop`. `Type=exec` detects execution failures, not HTTP readiness. A compatible application's readiness notification can support `Type=notify`. Explicit stop does not trigger `Restart=on-failure`.

The deployment owner validates the unit with the installed tooling, controls unit/drop-in/application writers and parent directories, and handles daemon reload, migration, and any boot enablement. Start and enable are different decisions. Runtime data belongs in a separately writable state directory rather than the release tree.

## Narrow noninteractive authority

Example sudoers entry, managed and validated by an administrator:

```sudoers
card-operator ALL=(root) NOPASSWD: /usr/bin/systemctl --no-ask-password start demo.service, /usr/bin/systemctl --no-ask-password stop demo.service
```

The [card](service-card.md) calls `sudo -n` with those exact argv values. It fails if authority is missing; it does not request a password or install policy. Do not grant arbitrary `systemctl *`, shells, `systemd-run`, edit/reload, or writable privileged adapter paths. This narrow entry does not remove broader rights the account may already possess.

Unit/application deployment and card approval remain separate. Read-only `show` access must also be verified. If observations and mutations need different SSH accounts/routes, split the card contexts using independently audited machine paths.

## User scope and other variants

A user unit uses that account's manager for every verb, including inspection. Its unit omits `User`/`Group`, uses the user-unit location and target, and its commands consistently select user scope. Verify the manager/bus is available in noninteractive SSH and has the required logout/reboot lifetime; administrator-configured linger can matter. An environment variable alone does not create a bus or running manager. Never silently fall back to system scope.

## Timing and validation

Default start/stop wait for the manager's job; `--no-block` proves only submission, while `systemctl --wait start` can wait for service termination rather than readiness. The example's 45-second card deadline allows room beyond its 20-second stop window, but dependencies, queueing, and transport can still exceed it. A card timeout still requires reconciliation.

Validate repeatability, denied access, failed start, readiness failure, stop timeout, and logout/reboot behavior in an authorized deployment window. Local JSON parsing cannot establish any of these remote facts.

Consult the installed version and upstream [service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html), [systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html), [loginctl](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html), and [sudoers](https://www.sudo.ws/docs/man/sudoers.man/) documentation.
