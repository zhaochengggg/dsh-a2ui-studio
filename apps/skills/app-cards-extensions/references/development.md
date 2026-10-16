# 独立组件包开发契约

运行时 API 为 1。插件为 `dsh-control-studio`，控制器是安装包内 `apps/lib/extensionctl.js`。从本 skill 的实际资源目录向上两级可定位 `apps`，不要猜测服务器上的绝对路径。下文将控制器绝对路径记作 `EXTENSIONCTL`。不改插件源码，不重建插件，不重启 DSH；安装成功后刷新网页。内置 telemetry.v1.Gauge 仍可直接使用。

## 源码与构建

每个包有 `extension.json` 和 `client.tsx`。参考安装包的 `apps/examples/extensions/range/` 可构建示例。源码集中在用户项目中的 `app-card-extensions/<包名>/`，build 子目录保存构建产物；不要把生成的源码散落进已安装插件目录。

extension.json:
```json
{"format":1,"apiVersion":1,"id":"example.v1","version":"1.0.0","description":"示例仪表","components":[{"name":"example.v1.Meter","properties":{"label":{"type":"text","binding":true},"value":{"type":"number","binding":true},"max":{"type":"number","binding":true},"child":{"type":"child","optional":true}}}]}
```

组件名必须以包 ID 加点开头；包主版本与 id 的 vN 一致。属性默认必填，可用 optional。type 支持 text、number、boolean、json、child、children；binding:true 允许数据路径，child/children 不使用 binding。text 可指定 enum 字符串数组，number 可指定 min/max。json 接受 JSON 对象/数组等复合值，用于复杂图表配置。未知属性会被拒绝。

`client.tsx` 导出 `components` 对象，键与 manifest 完全一致，值为 React 函数组件。可正常 import React/hooks、使用 JSX；构建器共享宿主 React，避免打包第二份 React。经审查的第三方库需在扩展源码目录可解析，并打包进入唯一模块。当前不支持额外 CSS 文件、图片文件和拆分 chunks；可用内联样式、SVG 和 Canvas。

可从 `app-cards/sdk` 导入 `RangeGauge`、`scaleColor`、`ratio`。RangeGauge 接受 label/value/min/max/marker/unit/fresh/colorScale/colorValue/colorMin/colorMax/ariaLabel。max 未知时不伪造量程。色标统一为 thermal（蓝绿黄红）或 reverse-thermal。

组件参数：
- `value(name)`：解析后的属性，可为 undefined/null，必须处理缺值。
- `has(name)`：声明是否实际提供此字段，区别“未写默认”和“绑定缺数据”。
- `raw`：已解析属性；子节点用 `child(raw.child)`，不要直接当普通 ReactNode。
- `child(node)`：复用原有子组件，例如 Button、输入框，保留动作授权与回执链路。
- `fresh`：绝对 /checks 路径引用的错误、过期和修订检查，加上显式 fresh:false。相对列表项应声明 fresh 布尔绑定或使用绝对检查路径。
- `ariaLabel`：无障碍标签。

自定义控件若需更复杂操作，先用子槽组合原有控件。此版本没有给扩展直接的服务器执行接口，安装也不授予服务器操作权限。组件为可信代码，故障边界仅隔离显示异常，不隔离恶意代码；不得用 eval、任意 URL 模块或 HTML 注入绕过包机制。

## 安装、升级、回滚

```sh
node "$EXTENSIONCTL" build SOURCE_DIR OUTPUT_DIR
node "$EXTENSIONCTL" install OUTPUT_DIR --trust-code
node "$EXTENSIONCTL" list
node "$EXTENSIONCTL" activate OLD_PACKAGE_KEY
node "$EXTENSIONCTL" disable example.v1
```

`--trust-code` 表示代码已经审查、获得部署授权，不是绕过授权的选项。CLI 默认使用 DSH_HOME（缺省当前用户的 ~/.dsh）下 app-cards；宿主覆盖过 appCards.dataPath 时显式传相同的 `--data-path`。隔离验收使用临时目录，不能误装进生产。

构建产生 manifest.json + client.mjs；安装校验 SHA-256 并存为不可变包。相同 id/version 不得修改内容，修复递增补丁版本；破坏性变化用新主版本，旧主版本可并存。

安装、切换和停用会先用候选目录校验当前已发布卡片，再原子更新注册表；不兼容会拒绝，不覆盖原活动目录。它检查声明兼容性，不能证明新代码行为完全兼容，仍须测试。尚未发布的草稿不阻止停用，之后发布时重新校验。

存储在 DSH_HOME/app-cards/extensions：packages/ 为按摘要寻址的已安装包，active.json 为唯一活动列表，history/ 保存切换前列表。旧包保留以支持回滚和已打开页面的版本 URL，不手工覆盖文件或删除正在使用的版本。

服务端立即读取新目录，app_cards_describe 能看到新增组件。浏览器刷新后加载一致的目录与模块；旧页面发现目录改变会提示刷新，不在运行中替换组件。组件模块加载失败仅显示局部错误，其余组件保持可用。第一次部署这套加载机制需要升级插件并重启一次，此后扩展安装无需重启。

## 验收

binding:true 属性现在同时接受路径和已注册纯函数调用，使用同一套 A2UI binder；visible、disabled、checks 由宿主统一提供。普通显隐、取反、计算和校验不应另建组件。详细语义见 app-cards-authoring/references/interactions.md。扩展应尊重宿主 disabled（原生输入在 fieldset 下自动禁用；自定义点击控件还需检查该值）；不要从 UI 绕开动作和校验链路。

先在隔离数据目录构建安装并加载真实产物，测试数据绑定、子节点、正常/缺值/过期、窄屏、交互、模块失败、版本不符和回滚。测试独立安装前后 DSH PID 不变、插件主 bundle 摘要不变，刷新后新增组件可用；不能只检查构建成功。

数值语义：功耗 max 使用硬件物理上限，marker 使用当前设定值；同型号同指标统一量程。连续颜色与 Card.warning 故障状态分开，高显存占用不等于故障。热降频采用真实状态标志，低时钟本身不足以定性。真实采样由探针执行，不为演示而给硬件加压。

任意 HTML/JS 沙箱尚未实现。不要用该受信任包机制接收未审查的远程代码。
