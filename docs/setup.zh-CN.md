# 安装与维护

DSH A2UI Studio 的安装标识仍为 `dsh-control-studio`；展示名称变更不要求已有用户重新安装或迁移数据。

[项目首页](../README.md) · [中文首页](../README.zh-CN.md)

DeepSeek Harness 的统一机器与应用管理插件。一个安装包提供机器目录、SSH 连接探测、机器引用，以及模型编写的应用监控/控制卡片；附带三套使用与扩展 skills。非 DeepSeek 官方插件。

## 支持范围

已验证 Linux、DeepSeek Harness `0.2.1-alpha.1`、Node `24.19`。Node `22.13` 是 API 最低要求，尚未实测；建议使用已验证版本。DSH 仍在快速迭代，不承诺跨版本兼容。

SSH 探测需要 `ssh`、`ssh-keyscan`、`ssh-keygen`。可选 libvirt 观察需要 `virsh`。插件不会修改局域网开放、代理、认证或 GPU 服务。

## 安装

下载预构建安装包，在运行 DSH 的用户下安装到现有 Web profile：

下载与 SHA256 校验命令见[中文首页](../README.zh-CN.md#安装)，确认校验通过后继续。

```sh
dsh plugin --profile web add ./dsh-control-studio-0.3.1.tgz --allow-build=esbuild
dsh --profile web --dump-config
```

重启 DSH 并刷新浏览器。无需安装其他机器管理或应用卡片插件。`--allow-build=esbuild` 仅允许扩展构建器所需的 esbuild 安装脚本，不是允许所有依赖执行脚本；安装前应确认包的来源可信。此参数已在 pnpm 11 验证。旧版 pnpm 若不支持该参数，请按其提示在 profile 内批准 esbuild 后重试。

本地命令执行默认未授权。需要时在 profile 的 `cordis.patch.yml` 中添加自己的目录白名单（替换示例路径）：

```yaml
- id: machine-apps
  name: dsh-control-studio
  config:
    appCards:
      hostRoots:
        - /srv/workspace
```

DSH 对同一行的 config 使用替换语义；已有配置时请保留其他必要字段。远程操作使用登记的 SSH 身份，卡片的执行授权仍需人工确认。

## 使用

在对话中让 Agent 使用 `machine-management` 登记机器、维护连接并记录用途；机器面板中的手动表单是备用入口。之后可以查看连接状态，通过 @ 气泡将已有机器附加到对话。应用卡片在机器详情中展示；模型通过配套 `app-cards-authoring` 和 `app-cards-extensions` skills 了解声明格式、真实预览与扩展流程。

卡片发布、执行审批和回执独立于外观声明。修改功耗等操作不会因为打开页面或安装插件自动执行。

## 数据与升级

默认数据根目录为 `DSH_HOME`，未设置时为 `~/.dsh`：

- `machines/`：机器 JSON、说明和历史。
- `machine-mgmt/ssh/`：SSH config 与 known_hosts；这是稳定数据路径，不是旧插件依赖。
- `app-cards/`：声明、修订、SQLite 索引、回执和动态扩展。

支持 `dataRoot`、`machineRoot`、`sshDir`、`appCards.dataPath` 覆盖路径。升级前停止 DSH 并备份数据，在同一 profile 中安装新版本，重启并刷新页面。卸载只移除插件，不删除数据：

```sh
dsh plugin --profile web remove dsh-control-studio
```

## 开发与打包

```sh
npm ci
npm run build
npm test
npm run test:apps
npm pack
```

`machines/` 和 `apps/` 是同一插件的内部模块，没有独立插件安装入口；`shared/` 提供共用 UI。数据格式与工具名称保持稳定。

预构建包包含运行产物与 skills。自定义卡片扩展控制器位于安装包内 `apps/lib/extensionctl.js`，示例位于 `apps/examples/extensions/range/`。构建扩展不需要修改或重启宿主插件。

目前分发方式为预构建 tgz；不要把源码仓库当作可直接 git 安装的包。官方安装机制见 [DSH 插件打包文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。
