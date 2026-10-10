# 声明式交互

内置与独立扩展共用 A2UI 的函数绑定。通过 app_cards_describe(topic: functions) 查列表，topic: components 查精确参数 schema；不要猜参数名。

## 绑定与状态

可读属性支持字面量、`{ "path": "/form/sync" }` 和 `{ "call": "not", "args": { "value": { "path": "/form/sync" } } }`。函数可嵌套，依赖变化立即重算。输入写回必须是直接 /form 或 /local 路径；函数值是只读派生值，不可反向写入。

所有组件支持 visible；输入、按钮和扩展控件支持 disabled。隐藏组件保留草稿，不会自动删除字段。显隐不是权限控制，也不是提交过滤。

函数目录：not(value)、and(values)、or(values)、equals(a,b)、not_equals(a,b)、greater_than(a,b)、less_than(a,b)、contains(string,substring)、starts_with(string,prefix)、ends_with(string,suffix)。另有 choose(condition,then,else)、coalesce(values)、add/subtract/multiply/divide(a,b)、clamp(value,min,max)、required(value)、numeric(value,min?,max?)、length(value,min?,max?)、formatNumber(value,decimals?,grouping?)、concat(values)、object(keys,values)。

coalesce 只回退 null/缺值，保留 false、0 和空字符串。数值运算不把 null 当 0；除零或非有限结果返回 null。choose 是纯派生选择，不触发状态修改；不要依赖分支短路。函数不能执行 shell、网络请求或任意 JS。call/path 为绑定保留键。

## 同时设置两卡

使用正向标签“同时设置两卡”，/form/sync 初值 true。共享输入 visible 绑定 sync；独立输入的父容器 visible 使用 not(sync)。分别保留 shared、gpu0、gpu1 草稿。

按钮 action.event.context.input 在点击时解析，可直接用包含绑定的对象：

```json
{
  "gpu0": {"call":"choose","args":{"condition":{"path":"/form/sync"},"then":{"path":"/form/shared"},"else":{"path":"/form/gpu0"}}},
  "gpu1": {"call":"choose","args":{"condition":{"path":"/form/sync"},"then":{"path":"/form/shared"},"else":{"path":"/form/gpu1"}}}
}
```

不要提交整个 /form 后指望隐藏的独立字段自动失效。普通组件需要动态对象结果时，使用 object(keys,values)；函数参数里的任意普通对象不会递归解析绑定，数组中的路径/函数会解析。

## 校验

输入可带 checks：

```json
[{"condition":{"call":"numeric","args":{"value":{"path":"/form/shared"},"min":100,"max":250}},"message":"请输入 100–250 W"}]
```

NumberField/Slider 自带数值、min/max/step 检查；min/max/step 也可绑定。清空为 null，不保留旧数值。错误显示在字段旁，可见且启用的无效字段默认阻止此 surface 中所有提交按钮；隐藏父容器下的输入不参与。一个独立提交域用一个 surface，避免无关表单互相阻塞。Button 自身 checks 只影响该按钮；validateForm:false 仅用于明确不依赖表单的辅助操作，不能用于绕过写操作校验。服务端 inputSchema/授权仍是最后防线，前端校验不替代它们。

验收：勾选/取消、独立草稿保留、刷新不覆盖、隐藏错误不拦截、可见错误阻止提交、最终参数正确；硬件控制使用模拟回调验收，未获授权不实际执行。
