# Compatibility audit — 2026-10-20

## Linux: DSH 0.2.1-rc.2

The existing deployment was upgraded from `0.2.1-alpha.1` to `0.2.1-rc.2`.
The plugin was tested in a copied profile before promotion. This source tree
now declares the two verified DSH versions through `engines.dsh`.

Verified on the live deployment:

- Machine directory and SSH probes load.
- Existing GPU card refresh executes its read-only operation and displays fresh
  values for both GPUs. Power-setting actions were not executed.
- Session list and custom model/reasoning selector load.
- Official experimental plugin market is enabled and the community index
  `https://dshmarket.com/index.json` loads in Plugins → Discover.
- LAN access behind the existing loopback nginx proxy works. Requests carrying
  an unrelated Origin remain rejected with HTTP 403.
- Before/after comparison: 178 session files, 51 machine files, five SSH files,
  and the credential file were byte-identical. Two card records, 26 grants and
  28 proposals were unchanged. Read-only checks create new monitoring receipts.

The LAN integration is deployment-specific, not part of this plugin. DSH rc.2
uses `Connection.admit()` for Peer-aware admission, so the old integration
needed adaptation; only changing `requestRejection()` was insufficient.

**Release distinction:** the existing v0.3.1 tarball is unchanged and still
declares exact alpha.1 peers without `engines.dsh`. A fresh rc.2 installation
of that tarball is blocked by the new compatibility check. Publish a new,
tested package before advertising one-click rc.2 installation; do not replace
the old tarball or bypass the safety check in installation instructions.

## Windows: partial compatibility, not yet supported end-to-end

The inspected desktop distribution is Anywhere Labs **DSH Desktop Beta
2.0.18-beta.1**, bundling DSH **0.2.1-rc.2** and Node **24.21.0**.
Its existing desktop profile was not modified.

An isolated copy of the published tarball imported successfully using the
desktop's own Node and dependencies. It registered two module definitions and
exposed 12 remote method descriptors. This is a module-loading smoke test,
not a full desktop UI or command-execution acceptance test.

Confirmed remaining issues:

- `machines/store.mjs` rejects Windows drive-letter SSH private-key paths.
- SSH probe/config generation assumes POSIX null paths and remote shell
  commands. Windows-local execution must not inherit those assumptions.
- Script operations support POSIX sh-compatible interpreters. PowerShell
  must use explicit argv operations; existing Linux cards are not portable
  merely by copying their declarations.
- Local Node tests: 31 passed, one could not create a symbolic-link fixture
  (`EPERM`). The separate application Vitest suite was not run because its
  development dependencies were unavailable in this checkout.

Do not label the published plugin fully Windows-compatible yet.

## Community market publication

The desktop bundles community storefronts as well as the official optional
index UI; they are not one central official marketplace.

The `dshmarket` storefront reads the **awesome-dsh-plugin** catalog.
Its current contribution process is a PR adding
`data/plugins/zhaochengggg__dsh-a2ui-studio.yml`, not editing its generated README.
Required basics include a `dsh.bundle` manifest, repository age of at least
one day, and the `dsh-plugin` topic. This repository meets those basics.

npm publication is optional for community-list inclusion: the storefront can
use a GitHub Release package. However, the catalog's standard format-1 index
currently describes npm-published entries with known versions, so community
listing alone does not guarantee visibility in official Discover.

Before submission, ship the rc.2-compatible release and state Windows limits
explicitly. No catalog PR, npm publication or new release was made during
this audit.

Sources:

- [Official market guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/guide/plugin-market.zh.md)
- [Community market](https://github.com/dsh-market/dsh-market)
- [Catalog contribution rules](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
- [Desktop distribution](https://github.com/anywhere-labs/dsh-desktop)
