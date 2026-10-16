# Rename to DSH Control Studio / 改名迁移

Version 0.3.1 renames `dsh-machine-apps` to `dsh-control-studio`. This is the same unified plugin, not a second service. The GitHub repository is now `zhaochengggg/dsh-control-studio`.

## What stays stable

- Machine IDs, connection IDs, card revisions, execution grants and receipts.
- Tool names and the `machine-management`, `app-cards-authoring`, `app-cards-extensions` skills.
- Default storage: `machines/`, `machine-mgmt/ssh/`, `app-cards/` under the existing DSH home. Do **not** rename these directories.
- The bundle configuration row ID `machine-apps` stays stable so existing overrides keep applying. Its `name` changes to `dsh-control-studio`.
- DSH sessions and credentials are outside this rename; no session conversion is required.

## Existing installation

1. Stop DSH. Back up the complete profile (including dependency files and custom configuration) and plugin data. Keep the old package for rollback.
2. Download and verify the new prebuilt release using the README instructions.
3. With the service still stopped, remove the old bundle and install the new one in the **same** profile:

   ```sh
   dsh plugin --profile web remove dsh-machine-apps
   dsh plugin --profile web add ./dsh-control-studio-0.3.1.tgz --allow-build=esbuild
   ```

4. Preserve all existing `config` values, including custom data paths and `hostRoots`. If an override still has `name: dsh-machine-apps`, change only that name to `dsh-control-studio`; retain `id: machine-apps`. Confirm `package.json` dependencies and profile bundles contain only the new package. Run `dsh --profile web --dump-config` and check there is exactly one active unified plugin.
5. Restart DSH and reload open browser tabs. The frontend module and RPC package identifiers changed, so an old cached page must not be kept running against the new backend.
6. Confirm existing machines, cards, permissions and history are present. Read/refresh a card first; a power-setting action is not necessary to validate this rename.

For a manually linked installation, replace the dependency link and bundle entry atomically while DSH is stopped, preserving the same configuration and data paths. Do not leave both bundles enabled.

## Rollback

Stop DSH, restore the backed-up profile and old package/link, restart and reload the browser. This release does not transform the data schema, so no reverse data migration is required. Do not overwrite newer user data merely to roll back code.

## 中文要点

新名字、新包名，原来的机器和卡片仍使用同一份数据。迁移前停服务并备份 profile 与插件数据；移除旧包、安装新包，保留所有自定义配置。配置行的 `id: machine-apps` 是稳定兼容标识，不必改；只把包名 `name` 改为 `dsh-control-studio`。确认只有一个包启用，再启动并刷新网页。

不要复制出另一套机器/卡片目录，不改会话，不删除授权、SSH 信任记录或旧备份。旧发布包仅用于历史与回滚，不与新包同时加载。
