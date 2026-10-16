# DSH Machine & Apps

**Describe the controls you need. Keep a panel you can use.**

A DeepSeek Harness plugin for agent-authored, persistent monitoring and control panels, attached to the machines they operate on.

[中文](README.zh-CN.md) · [Download v0.3.0](https://github.com/zhaochengggg/dsh-machine-apps/releases/tag/v0.3.0) · [Setup](docs/setup.md) · [GPU walkthrough](docs/gpu-walkthrough.md)

![Real GPU monitoring card with per-device metrics and power controls](docs/media/gpu-panel.png)

![Synchronized GPU power controls in the same card](docs/media/gpu-controls.png)

*A real agent-authored dual-V100 panel in DSH. This is an example card, not a built-in GPU dashboard; the plugin is not GPU-specific.*

## From a request to a reusable panel

1. **Describe the job.** Attach a registered machine to the conversation and explain what you want to monitor or control.
2. **Review the actual UI.** The agent uses bundled skills to inspect the application, propose a card, and preview the real renderer. Review actions and permissions before use.
3. **Use it directly.** Return to the machine's panel to read status, change a setting, or inspect an action receipt—without asking the model to repeat the same operation each time.

For example: “Compare both GPUs at a glance, highlight thermal pressure, and let me set their power limits together or separately.” [See the workflow →](docs/gpu-walkthrough.md)

## What is included

| Capability | What it gives you |
| --- | --- |
| Machine directory | Persistent records, multiple SSH paths, default connection, health checks, and @ references |
| Application cards | Model-authored layouts, data bindings, conditional controls, and numeric color scales |
| Persistent operations | Card revisions, publication review, execution permissions, and action receipts |
| Extensible UI | A component catalog plus custom card extensions when standard components are insufficient |
| Agent skills | Machine management, card authoring, and extension development guidance shipped with the plugin |

The UI follows an **A2UI-inspired** approach: the agent describes a structured interface and the host renders it. This is not a claim of full A2UI protocol compatibility. Custom extensions are a separate, code-bearing capability and should be reviewed accordingly.

## Install

**Prerelease. Verified: Linux · DSH `0.2.1-alpha.1` · Node `24.19`.** Other DSH versions may require adaptation. Independent community project, not an official DeepSeek plugin.

Download and verify the prebuilt package:

```sh
curl -fL -o dsh-machine-apps-0.3.0.tgz \
  https://github.com/zhaochengggg/dsh-machine-apps/releases/download/v0.3.0/dsh-machine-apps-0.3.0.tgz
echo 'c74f5f44cc495c5eccec1d6a6ce516c531bcd429adea94677718e975623b6f1d  dsh-machine-apps-0.3.0.tgz' | sha256sum -c -
```

After the checksum reports `OK`, install as the DSH user:

```sh
dsh plugin --profile web add ./dsh-machine-apps-0.3.0.tgz --allow-build=esbuild
dsh --profile web --dump-config
```

Restart DSH and refresh the browser. Replace `web` with your profile name if needed. This is **one package**; no legacy plugins are required. Use the release tarball, not a git install. `--allow-build=esbuild` approves the extension builder's dependency script; see [setup and permissions](docs/setup.md) before enabling execution.

## Start with a read-only card

Open the machine panel, register a machine, and attach it with @. Ask the agent to use the bundled `machine-management` and `app-cards-authoring` skills to inspect the target and propose a read-only panel first. Add controls after confirming what each action executes.

Opening a card does not automatically apply its settings. Local execution is not authorized by default. This plugin does not change network exposure, proxies, authentication, or GPU services during installation.

## Go deeper

- [Setup, permissions, data locations, upgrades, and development](docs/setup.md)
- [GPU example: request, preview, and everyday use](docs/gpu-walkthrough.md)
- [Card authoring skill](apps/skills/app-cards-authoring/SKILL.md)
- [Custom extension skill](apps/skills/app-cards-extensions/SKILL.md)
- [Machine management skill](skills/machine-management/SKILL.md)

Have an application you want to manage? [Open an issue](https://github.com/zhaochengggg/dsh-machine-apps/issues) with your DSH version, intended panel, and redacted logs or screenshots. Do not include credentials or private machine addresses.
