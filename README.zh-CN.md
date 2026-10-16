# DSH Control Studio

**把你需要的监控和操作告诉 Agent，留下一个可以反复使用的面板。**

DeepSeek Harness 的机器与应用管理插件：Agent 为实际应用编写定制 UI 卡片，人直接在机器面板里查看状态、调整设置，不必每次重新发指令。

[English](README.md) · [下载 v0.3.1](https://github.com/zhaochengggg/dsh-control-studio/releases/tag/v0.3.1) · [安装与维护](docs/setup.zh-CN.md) · [GPU 示例](docs/gpu-walkthrough.md)

![DSH Control Studio 演示：查看指标、切换独立设置、恢复同步设置](docs/media/control-studio-demo.gif)

*由真实界面截图剪辑：查看指标 → 独立设置 → 恢复同步。未提交任何参数修改，仅展示应用区域。双 V100 是 Agent 编写的使用案例，并非安装后自带的固定面板；插件不局限于 GPU。*

## 怎么用

1. **描述需求。** 在对话里 @ 已登记机器，告诉 Agent 要观察什么、操作什么。
2. **看真实预览。** Agent 结合配套 skill 检查应用、生成卡片声明；先看实际渲染，再审核操作与权限。
3. **直接使用面板。** 卡片保存在机器下。以后看状态、调参数、查执行回执，直接使用界面，不必重新让模型跑一遍。

例如：“把两张 GPU 放在一起比较，突出散热压力，让我能同时或分别设置功耗墙。” [查看示例流程 →](docs/gpu-walkthrough.md)

## 一个包里有什么

| 能力 | 用途 |
| --- | --- |
| 机器目录 | 持久化记录、多条 SSH 连接、默认路径、连接探测与 @ 引用 |
| 应用卡片 | 模型编写布局、数据绑定、条件控件与连续数值色阶 |
| 持久化操作 | 卡片修订、发布审核、执行授权与操作回执 |
| UI 扩展 | 标准组件不够时，使用自定义卡片扩展 |
| 配套 skills | 教模型如何管理机器、编写卡片、开发扩展与验证真实界面 |

这是 **A2UI-inspired** 的实现：模型描述结构化界面，宿主负责渲染；并不宣称完整兼容 A2UI 协议。自定义扩展包含代码，需要单独审查，不能等同于纯声明式布局。

## 安装

**当前为预发布版。已验证 Linux、DSH `0.2.1-alpha.1`、Node `24.19`。** 其他 DSH 版本可能需要适配。非 DeepSeek 官方插件。

先下载并校验：

```sh
curl -fL -o dsh-control-studio-0.3.1.tgz \
  https://github.com/zhaochengggg/dsh-control-studio/releases/download/v0.3.1/dsh-control-studio-0.3.1.tgz
curl -fL -o SHA256SUMS \
  https://github.com/zhaochengggg/dsh-control-studio/releases/download/v0.3.1/SHA256SUMS
sha256sum -c SHA256SUMS
```

确认输出 `OK` 后，以运行 DSH 的用户安装：

```sh
dsh plugin --profile web add ./dsh-control-studio-0.3.1.tgz --allow-build=esbuild
dsh --profile web --dump-config
```

重启 DSH、刷新浏览器。`web` 按实际 profile 名称替换。只需这一个包，不需要旧的两个插件。当前使用预构建 tgz 分发，不要直接用 git 安装；尚未发布 npm 包。`--allow-build=esbuild` 仅批准扩展构建器需要的依赖脚本。

## 第一次建议先做只读面板

已经安装 `dsh-machine-apps` 的用户，请先阅读[改名迁移说明](docs/migration.md)，不要同时启用两个包。

登记机器并 @ 到对话，让 Agent 使用 `machine-management` 和 `app-cards-authoring` skills，先检查目标应用，再提出只读卡片。确认数据来源和显示正确后，再添加操作按钮。

本地执行默认未授权；远程操作使用登记的 SSH 身份。打开卡片不会自动应用设置。安装插件也不会修改网络开放、代理、认证或 GPU 服务。目录白名单、数据路径、备份与升级见[安装与维护](docs/setup.zh-CN.md)。

想接入自己的应用？欢迎[提交 issue](https://github.com/zhaochengggg/dsh-control-studio/issues)，说明 DSH 版本、想要的面板和脱敏后的错误信息。不要上传凭据或私有机器地址。
