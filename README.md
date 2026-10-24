# dsh-tool-gate

把整包工具从会话的工具面上摘下来，要用时一条命令挂回去。

不是卸载插件——插件还在跑、能力还在，只是模型此刻看不见那些工具。**省的是每轮都会重发一遍的工具定义。**

## 为什么

工具表是每一轮请求都要重发的固定开销。装了几个大件之后，它可能占掉几万字符：

```
122 个工具 = 99,337 字符
其中 browser 20,644 + wincu 18,470 + ig5 12,465 = 51,579（51.9%）
而这三包在那一整天里被调用了 0 次
```

## 装

三步。少一步都不会生效，而且不会报错。

```jsonc
// 1. ~/.dsh/profiles/<你的 profile>/package.json 的 dependencies
"dsh-tool-gate": "link:<本地工程绝对路径>",

// 2. 同一个文件的 dsh.profile.bundles 数组里加一行
"dsh-tool-gate"
```

```powershell
# 3. 建 junction（或 pnpm install），然后重启宿主
New-Item -ItemType Junction `
  -Path "$HOME\.dsh\profiles\<profile>\node_modules\dsh-tool-gate" `
  -Target "<本地工程绝对路径>"
```

装了不生效的排查顺序（血泪）：

1. 先看工具表里有没有 `tool_gate`。没有就往下。
2. 设 `DSH_TOOL_GATE_DEBUG=1` 再重启，会在工作目录生成 `dsh-tool-gate-debug.log`。
   - **没有这个文件** → profile 根本没加载这个包，回去查上面三步。
   - 有 `constructed` 没有 `inject callback` → `ctx.inject` 没触发，tools 服务没就绪。
   - 有 `register ok` 但工具不在 → 查 agent 作用域。
3. `package.json` 别带 UTF-8 BOM（首字节应是 `7B`），带了整份 profile 都不加载。

## 用

```
tool_gate(action: "status")                       # 现在收着哪些
tool_gate(action: "park")                         # 全部收起来（默认状态）
tool_gate(action: "mount")                        # 全部挂回来
tool_gate(action: "mount", groups: ["browser"])   # 只挂浏览器
```

改完下一个 step 的工具表就变，不用重启、不用改文件。

## 配置

```yaml
- id: plugin-tool-gate
  name: 'dsh-tool-gate'
  config:
    # 默认收着哪些组；清空 = 默认全挂出来
    parked: [browser, wincu, ig5]
    # 加自己的包：模式以 * 结尾按前缀匹配，否则精确匹配
    groups:
      mine: ['my_tool_*']
      one: ['exactly_this_tool']
```

## 实测

同一套对话、同一个会话，只切开关：

| | 工具数 | 工具表字符 |
|---|---:|---:|
| 全挂 | 123 | 99,789 |
| 收起三包 | 57 | 48,144 |
| | **-66** | **-51,645（51.8%）** |

（差的那 452 字符是 `tool_gate` 自己的定义。）

按 0.054 元/百万 input token 算，每请求省约 **0.0014 元**。一百个请求一毛四。

**收益就这么点。** 它值得存在的理由是：工具表不该由"我可能要用"来决定，而该由"我现在要用"来决定。

## 实现要点（给改这份代码的人）

- 用 `ctx.inject(['tools'], cb)` 等工具服务就绪再注册。**模块级 `export const inject = ['tools']` 不够**——它只声明依赖，不保证构造那一刻 `ctx.tools` 这个访问器可读，实测会在 `typeof ctx.tools.register` 那一行静默抛错，插件就那么没了。
- `ctx.tools.restrict()` 只在 agent 作用域里可用（`agent.ctx`）。全局调会抛「a context-global restriction would mask every agent」。
- 每个 agent 各存一份状态（WeakMap），重复 apply 前先 `dispose()` 掉上一次的 restriction。
- 摘掉的是**全局工具**；agent 自己 scoped 注册的工具摘不掉。

## 已知限制

- **摘工具摘不掉说明书。** 有些工具包会同时往 system prompt 塞一段使用说明
  （`dsh-builtin-browser` 就塞了 1,336 字符的 "Use the dsh_browser_* tools…"）。
  那些 section 是插件在自己作用域里注册的，`tool_gate` 拿不到它们的 disposer，
  所以工具摘了、说明书还在。表现是：模型被告知有某组工具，实际调不到。
  要彻底收干净，得那个插件支持关掉自己的注入——本插件做不到。
- 只摘得掉**全局注册的工具**。agent 自己 scoped 注册的工具不属于可摘范围。
- `restrict` 是 agent 级的：新起的 subagent 会各自被 gate 一次，互不影响。

## 回滚

- 让工具回来：`tool_gate(action: "mount")`，立刻。
- 停用插件：把 `dsh-tool-gate` 从 `dsh.profile.bundles` 里删掉，重启。
- 什么都不改也不影响：默认行为只是把工具表变小，插件没改任何数据。

## License

MIT
