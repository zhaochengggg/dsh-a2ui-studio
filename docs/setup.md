# Setup and maintenance

DSH A2UI Studio keeps the installation ID `dsh-control-studio`. Existing installations do not need migration for the display-name change.

[Overview](../README.md) · [完整中文说明](setup.zh-CN.md)

Verified on **Linux, DeepSeek Harness `0.2.1-alpha.1`, Node `24.19`**. Node `22.13` is the API minimum, not a tested configuration. Newer DSH releases are not automatically compatible.

Follow the [download, checksum, and installation steps](../README.md#install). Run as the user who runs DSH, using the intended profile. SSH checks require `ssh`, `ssh-keyscan`, and `ssh-keygen`; optional libvirt observation requires `virsh`.

`--allow-build=esbuild` permits that dependency's installation script for the extension builder, not arbitrary dependency scripts. The command was verified with pnpm 11. For older pnpm, follow its instructions to approve esbuild in the profile and retry. Review the package source before allowing scripts.

Use the release `.tgz`, not GitHub's source archive or a git package specifier. npm distribution is not currently provided.

## Execution permissions

Local command execution is not authorized by default. If needed, add your own directory allowlist to the profile's `cordis.patch.yml`:

```yaml
- id: machine-apps
  name: dsh-control-studio
  config:
    appCards:
      hostRoots:
        - /srv/workspace
```

Replace the sample path. DSH replaces config for a matching row; preserve other required fields when editing existing configuration. Remote operations use registered SSH identities. Card execution permissions still require human approval; publishing a visual layout is not a blanket execution grant.

## Data and upgrades

Default root: `DSH_HOME`, or `~/.dsh` when unset.

| Path | Contents |
| --- | --- |
| `machines/` | Machine JSON, notes, history |
| `machine-mgmt/ssh/` | SSH config and known_hosts; a stable data path, not an old plugin dependency |
| `app-cards/` | Declarations, revisions, SQLite index, receipts, dynamic extensions |

Overrides: `dataRoot`, `machineRoot`, `sshDir`, `appCards.dataPath`.

Before upgrading, stop DSH and back up these data directories. Install the new package in the same profile, restart, and refresh the browser. Removal keeps data:

```sh
dsh plugin --profile web remove dsh-control-studio
```

## Development

```sh
npm ci
npm run build
npm test
npm run test:apps
npm pack
```

`machines/` and `apps/` are internal modules of one plugin. `shared/` holds common UI. The prebuilt package includes runtime output and skills. The extension controller is `apps/lib/extensionctl.js`; a sample lives in `apps/examples/extensions/range/`. Supported card extensions can be built without modifying or restarting the host plugin; follow the bundled extension skill for validation and activation.
