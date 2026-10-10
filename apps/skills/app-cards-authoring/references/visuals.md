# 数值与异常

先用 app_cards_describe topic: components/extensions 查看已安装能力。

连续颜色：Metric、Progress、Card 都支持 colorScale: thermal（蓝→绿→黄→红）或 reverse-thermal。colorValue 默认 value，colorMin/colorMax 可为数值或路径。默认起点 0、终点 100；明确给出适合指标的范围。失效量程呈未知，不假设健康。

条形量程：Progress 的 min/max 可以绑定数值，marker 为独立设定标线；unit 为单位。自定义组件 telemetry.v1.Gauge 默认连续色标。颜色默认跟随条形量程；只有确有语义差异时才独立指定 colorMin/colorMax。

```json
{"id":"power","component":"telemetry.v1.Gauge","label":"功耗","value":{"path":"/checks/gpu/value/power"},"min":0,"max":{"path":"/checks/gpu/value/hardwarePowerMax"},"marker":{"path":"/checks/gpu/value/enforcedPowerLimit"},"unit":"W"}
```

Card 支持 warning（布尔绑定）及 warningText（文本绑定），异常时背景泛红、说明出现。热余量颜色与故障状态分别判断；显存满载或较低空闲频率不自动等于异常。Card 也可显式传 colorScale/colorValue/colorMin/colorMax 给整卡连续染色。

绝对 /checks/... 绑定会按宿主证据自动处理错误、过期和修订不符，避免旧数据呈现健康颜色。相对列表路径应补充 fresh 绑定或绝对观测路径。缺值不填 0，功耗上限未知就显示未知，不能拿设定值代替硬件上限。

同型号设备同一指标统一量程；不同指标分别设置。保留数字和单位以便精确读取及无障碍使用，平时靠颜色比较。正常时隐藏异常解释可用 visible 布尔绑定，不隐藏未知/过期状态。确认颜色在暗、亮主题下清楚且不刺眼。
