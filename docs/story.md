# Give the job to the agent

[English overview](../README.md) · [中文首页](../README.zh-CN.md)

Control Studio is a place for an agent to keep machine knowledge and leave useful application interfaces. You describe the job; registration is part of the agent's work, not a form you must fill out first.

## Tell it which machine and what you want

> Register this machine as Queue server. Read the application documentation and remember where the queue lives.

The bundled `machine-management` skill teaches the agent to check the directory, inspect existing records and call `machine_manage` to create or update an archive. Machine identity stays stable when an address changes. Remote access still needs an authorized SSH setup and a trusted host fingerprint; secrets should not be pasted into notes.

The manual registration/edit form remains available when you want direct control. It is not the primary onboarding path.

![Real agent registration conversation](media/agent-register.png)

## Ask for an application-specific interface

> Make a read-only panel showing running, waiting, completed and failed jobs, plus concurrency.

With `app-cards-authoring`, the agent investigates the data source, saves the important facts, and proposes a card. You review the execution definitions before publication. For an existing application it can reuse a known layout, or design a different one when the job needs it.

![Saved application knowledge](media/agent-notes.png)

## Come back and continue

The panel and notes stay in the machine archive. Read the panel directly for routine checks. Use **@** to bring that machine back into a conversation when you need diagnosis, configuration changes or a new interface. The plugin retains knowledge explicitly written by the agent, not every message in every chat.

![Saved panel](media/agent-panel.png)

## 中文：交代目标，其余交给 Agent

1. **让 Agent 纳管。** 提供机器线索和用途，它查重、登记、记录连接与说明。手动表单只是备用入口。
2. **让 Agent 理解应用。** 它读取实际部署与数据源，把应用知识写回档案，提出专属卡片，交你审阅执行定义。
3. **日常使用，继续委托。** 平时直接看卡片；需要处理问题就 @ 机器，利用已经留下的上下文继续工作。

## About these screenshots

These are actual DSH screenshots, not generated mockups or a fabricated conversation. This run starts by asking the local model to register `queue-demo` (队列服务器); the agent calls the plugin tools and reads the demo application's files. A follow-up asks it to adapt a previously verified queue-card template for that new machine and submit it through the normal review tools.

The queue is a JSON fixture in a separate demo workspace. The demo has its own DSH home and plugin copy, no production machine records, and no SSH connection. The process cannot see the production home directory; writes are confined to its demo tree. Registration of a local record is not evidence of a verified remote connection.

The homepage uses three separate short GIFs (8, 8 and 7.5 seconds): revisiting the agent's registration result, inspecting saved knowledge and the published panel, and attaching the machine with @. These are recordings of the completed demo, not a claim that generation finishes in eight seconds. No new inference request is submitted during this recording. The static screenshots above remain available for reading at your own pace. The older long GIF with manual registration remains retired.

For a different application, see the [dual-GPU monitoring and power-control example](gpu-walkthrough.md). That is a previously deployed panel, not the output of this queue demo.
