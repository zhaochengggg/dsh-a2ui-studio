# DSH Control Studio

**你的机器与应用，由 Agent 管理，由 Control Studio 记住。**

为 DeepSeek Harness 中的 Agent 提供长期可用的机器档案、应用记录和操作界面。从登记一台机器，到 @ 给 Agent、让它管理应用，再到生成专属卡片——让一次对话的成果成为下次工作的起点。

[English](README.md) · [下载 v0.3.1](https://github.com/zhaochengggg/dsh-control-studio/releases/tag/v0.3.1) · [安装与维护](docs/setup.zh-CN.md) · [完整使用故事](docs/story.md)

![登记机器、@ 引用、委托 Agent 管理应用并生成卡片](docs/media/control-studio-story.gif)

*真实 DSH 的剪辑录屏，包含实际审批截图；推理等待已缩短。独立演示机器与任务队列数据，不含生产记录。详见[录制说明](docs/story.md)。*

## 从接入机器，到持续交给 Agent 管理

1. **登记机器。** 写下名称和用途，按需添加 SSH 连接；也可以先登记、稍后连接。机器身份与连接路径保存在同一份档案里。
2. **@ 给 Agent。** 在机器上点击 @，把目标带进对话。Agent 通过插件工具读取说明和连接信息，你不用每次重新交代。
3. **让它管理应用。** 检查部署、记录配置、排查问题，或者把常看的指标做成面板。Agent 使用已有工具与获准的访问权限完成工作，并把值得记住的事实写回档案。
4. **审阅并授权。** 查看真实卡片，确认操作定义与权限，再发布使用。生成了按钮，不等于已经执行命令。
5. **下次直接继续。** 打开机器使用卡片，或在新对话里再次 @ 它。说明、重要历史、卡片版本与操作回执都还在。

> “帮我纳管这台机器上的任务队列，记住应用放在哪里，做个面板让我看运行中、等待、完成和失败的任务。”

Agent 负责理解与执行，插件负责长期记录与界面承载。它保存 Agent 明确写入的知识，而不是自动记住所有对话；权限仍由你掌握。

另一个实际案例：[双 GPU 监控与功耗控制](docs/gpu-walkthrough.md)。卡片是管理过程留下的工作界面，不是插件的全部。

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
