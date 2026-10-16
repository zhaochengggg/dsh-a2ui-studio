# 定制卡片的交互设计

## 组件

- Row / Column / Grid(columns:1..6)：自由布局，Grid 窄屏折为单列。
- Metric(label,value,unit?,hint?)：快照指标，缺值显示破折号。
- Sparkline(label,values,unit?)：真实采样序列，最多 512 点。运行时不伪造或累积历史，数据源需提供序列。
- Progress(label,value,max?)：进度，未知值为不定进度。
- Status(checkId)：宿主证据的健康、时间和过期状态。
- Table(columns:[{title,key}],rows)：结构化列表。
- NumberField / Slider(label,value,min,max,step?,unit?)：数值草稿，写数值而不是字符串。
- TextField：字符串，即使 variant=number 也沿用字符串语义；需要数字用 NumberField。
- ChoicePicker：字符串数组选择，单选也为单元素数组。CheckBox 写布尔值。
- Button：variant 为 primary/default/borderless/danger，confirm 可给危险动作附加简短确认。
- Tabs / Disclosure：低频信息按需展开。RunReceipt(actionId) 显示动作事实，不冒充健康。
- Link(label,url)：仅完整 HTTP(S)，新标签页打开；CodeBlock 为纯文本，不执行 HTML/JS。

共同 visible 支持字面量、路径和函数，Status/RunReceipt 也适用；隐藏不是授权机制。accessibility.label 给图标等提供可访问名称。组件引用必须存在，根 id 必须为 root。

## 实际形态与密度

机器面板和应用卡片现在随同一个 dsh-control-studio 插件发布。按钮、焦点、状态色由共用 UI 层控制；不要在卡片中复制顶栏刷新按钮、重设全局 input/button 样式，或用文本字符模拟图标。需要新增通用控件时扩展共用层，不在两个模块分别补样式。应用保持视觉主体；多条连接在默认路径下折叠，说明和历史保持次级。

| 组件 | 实际布局与选择依据 |
| --- | --- |
| Row | 按内容宽横排并换行，不自动等宽铺满；适合按钮组、短标签。 |
| Grid | 等分可用宽度，窄面板降为单列；适合并列设备卡。 |
| Metric | 标签、较大读数、可选提示；不是紧凑的一行文字。 |
| Status | 默认 compact：一行状态，悬停或点击查看 summary/时间；variant:detailed 常驻展开说明与时间。未知、异常、过期仍显示状态，不再重复放 summary。 |
| telemetry.v1.Gauge / Progress | 共用布局：名称左、右侧「当前值 / 最大值 单位」、下方 6px 条；没有下方刻度或量程按钮。marker 保留条上标线，悬停可看设定值。variant 仅控制间距，min、marker、colorScale 不切换排版。缺值/过期明确提示，不显示健康颜色。Progress 默认中性色，Gauge 默认连续热色；按指标含义选择。单位用 unit，不要再写入 label。 |
| CheckBox | 勾选框紧邻文本，长标签换行留在文字列；错误另起一行。 |
| RunReceipt | 默认空闲不占位，empty:label 显示“暂无运行”。actionId 或 actionIds 二选一；多动作汇总显示最新动作及名称，恢复操作也可追溯。 |

以上是结构而非固定行数，真实文字、宽度和状态会改变高度。效果图使用真实组件与宿主样式，不另写 HTML 猜测组件外观。面板样式不得跨越 data-machine-detail-card 插槽边界控制应用控件。

## 有数据的安全预览

声明 ui.previewScenarios（最多 8 项），每项为 name、checks 和可选 runs。checks 用已有 checkId，值为 {value,health,summary,stale?}；runs 用 {actionId,state,value?}。不要放密码或密钥。例：

```json
{"name":"热降频","checks":{"metrics":{"value":{"power":230},"health":"unhealthy","summary":"GPU 1 热降频"}},"runs":[{"actionId":"apply","state":"failed","value":{"message":"模拟失败"}}]}
```

metrics/apply 必须对应声明，value 结构要匹配绑定路径。propose 后在真实机器面板选草稿和“预览场景”，检查正常、异常、过期、空数据、执行结果；输入仍可试，执行和取消均禁止。模拟数据不会写入观测/回执，也不会被已发布界面当作当前事实。

调整面板宽度、检查亮暗主题及控件对齐，再给用户效果图。隔离组件测试不能代替宿主集成验收；纯 HTML 图只能表达概念，不作为落地承诺。

## 数据与草稿

/data 是静态数据，不是当前状态。/checks/<id>/value 为 evaluate 返回对象，保留 health、summary 并附加 UI 字段。/form 来自 surface.formInitial，是尚未提交的草稿；/local 为临时交互数据。观测更新不应重建表单。

显示“当前值”和“拟设置值”，不要在滑块 onChange 时执行变更。复杂双向初始化尚不支持时明确限制或扩展运行时，不用前端 JS 绕过绑定。

调节控件片段（仍需完整有效声明）：

```json
[
 {"id":"root","component":"Column","children":["current","target","apply","receipt"]},
 {"id":"current","component":"Metric","label":"当前并发数","value":{"path":"/checks/settings/value/concurrency"}},
 {"id":"target","component":"Slider","label":"拟设置并发数","value":{"path":"/form/concurrency"},"min":1,"max":16,"step":1},
 {"id":"apply","component":"Button","variant":"primary","child":"applyLabel","action":{"event":{"name":"app.invoke","context":{"actionId":"applySettings","input":{"path":"/form"}}}}},
 {"id":"applyLabel","component":"Text","text":"应用设置"},
 {"id":"receipt","component":"RunReceipt","actionId":"applySettings"}
]
```

formInitial 为 {"concurrency":4}，inputSchema 中为 number/integer。argv 仅接受字符串，需要数值时可用固定程序读取 JSON stdin，或用 transform/flow 显式转换，不依赖隐式转换。

## 按应用设计（不是固定模板）

- 推理服务：模型、队列、显存、吞吐、拟设置参数与生效值、按需加载卸载；不擅自 GPU 压测。
- 代理：延迟、连通、路由、节点选择；不默认打开公网管理端口。
- 下载器：任务表、速度、进度、暂停继续、限速；取消任务与删除文件分开。
- 系统服务：进程状态与业务就绪分开，必要启停、最近日志、回执。

修改时对照旧功能清单。自动刷新、键盘、焦点、折叠、标签页、拖动尺寸、@引用、入口对齐都可能是用户依赖。插件只贡献机器详情区域，不修改机器面板和聊天输入。
