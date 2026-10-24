/**
 * dsh-tool-gate —— 把手脚收起来，要用时再伸出去。
 *
 * 整包工具（浏览器、桌面操控、逆向套件……）会把工具表撑到几万字符，每轮重发一次，
 * 而大多数会话一次都不调用。这个插件按 agent 把指定工具从工具面上摘掉
 * （ctx.tools.restrict({ deny }) —— 只在 agent 作用域里有效、随时可撤销），
 * 需要时一条 tool_gate 命令挂回来。
 *
 * 不是卸载插件：插件还在跑，能力还在，只是模型此刻看不见它们。
 * 刻意不往 system prompt 写一个字：存在的理由是让每轮固定开销变小。
 */
export const name = 'tool-gate'
export const inject = ['tools']

const DEBUG = process.env.DSH_TOOL_GATE_DEBUG === '1'
const PROBE = 'dsh-tool-gate-debug.log'
let fsProbe = null
if (DEBUG) {
  try {
    fsProbe = await import('node:fs')
  } catch {
    /* 没有 fs 也能装 */
  }
}
const probe = (msg) => {
  if (!DEBUG) return
  try {
    fsProbe?.appendFileSync(PROBE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* 调试日志写不了不影响插件 */
  }
}

let defineTool = (def) => def
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool
} catch {
  /* 没有 dsh-tools 也能装，只是工具注册会跳过 */
}

/**
 * 组名 → 匹配模式。以 `*` 结尾按前缀匹配，否则精确匹配。
 * 想加自己的包：在配置里写 groups: { mine: ["my_tool_*"] }，再放进 parked。
 */
const DEFAULT_GROUPS = {
  browser: ['dsh_browser_*'],
  wincu: ['mcp__wincu__windows_computer_use_*'],
  ig5: ['ig5_*'],
}

const hit = (name, pattern) =>
  pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern

export default function toolGate(ctx, config = {}) {
  const groups = { ...DEFAULT_GROUPS, ...(config.groups || {}) }
  const initial = Array.isArray(config.parked) ? config.parked : Object.keys(DEFAULT_GROUPS)
  const states = new WeakMap()
  let lastAgent

  const stateOf = (agent) => {
    let s = states.get(agent)
    if (!s) {
      s = { parked: new Set(initial.filter((g) => groups[g])) }
      states.set(agent, s)
    }
    return s
  }

  /** 这个 agent 能看见的全局工具名。要不到就返回空（插件不该因此炸掉）。 */
  const knownNames = (agent) => {
    try {
      const view = agent.ctx.tools.view(agent)
      return view && view.restrictableNames ? [...view.restrictableNames] : []
    } catch {
      return []
    }
  }

  const apply = (agent) => {
    const s = stateOf(agent)
    const names = knownNames(agent)
    const deny = new Set()
    for (const g of s.parked) {
      for (const pattern of groups[g] || []) {
        for (const n of names) if (hit(n, pattern)) deny.add(n)
      }
    }
    try {
      if (typeof s.dispose === 'function') s.dispose()
    } catch {
      /* 撤销旧的失败不阻断重装 */
    }
    s.dispose = undefined
    s.lastError = undefined
    if (deny.size === 0) return { parked: [...s.parked], deny: [], lastError: s.lastError }
    try {
      s.dispose = agent.ctx.tools.restrict({ deny: [...deny] })
    } catch (err) {
      s.lastError = err instanceof Error ? err.message : String(err)
    }
    return { parked: [...s.parked], deny: [...deny], lastError: s.lastError }
  }

  const start = (c) => {
    probe(`start tools=${typeof c?.tools}`)

    try {
      c.on('agent/created', ({ agent }) => {
        lastAgent = agent
        try {
          const r = apply(agent)
          probe(`agent/created deny=${r.deny.length} err=${r.lastError ?? 'none'}`)
        } catch (err) {
          probe(`apply ERR ${err && (err.stack || err.message || err)}`)
        }
      })
    } catch (err) {
      probe(`ctx.on ERR ${err && (err.stack || err.message || err)}`)
    }

    try {
      if (typeof c?.tools?.register !== 'function') {
        probe('no tools.register')
        return
      }
      c.tools.register(
        defineTool({
          name: 'tool_gate',
          description:
            '收放自己的手脚：把整包工具从**当前会话**的工具表里摘掉，省掉每轮固定重发的几万字符；要用时一条命令挂回来。不是卸载插件，随时可逆，下一个 step 的工具表就变。',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['status', 'park', 'mount'],
                description: 'status=看现状；park=收起来；mount=挂回来',
              },
              groups: {
                type: 'array',
                items: { type: 'string' },
                description: '组名（配置里定义的键），或 all；不填 = 全部组',
              },
            },
            required: ['action'],
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
              required: ['ok'],
            },
            render: (_args, value) => [{ type: 'text', text: String(value?.text ?? 'tool_gate: 无输出') }],
          },
          async execute(args, exec) {
            const agent = (exec && exec.agent) || lastAgent
            if (!agent) return { ok: false, text: 'tool_gate：拿不到当前 agent 作用域，收放不了。' }
            const s = stateOf(agent)
            const asked = Array.isArray(args?.groups) && args.groups.length > 0 ? args.groups : ['all']
            const want = [...new Set(asked.flatMap((g) => (g === 'all' ? Object.keys(groups) : [g])))]
            const bad = want.filter((g) => !groups[g])
            if (bad.length) {
              return { ok: false, text: `tool_gate：不认识 ${bad.join(', ')}；可用组：${Object.keys(groups).join(' / ')}` }
            }
            if (args?.action === 'park') for (const g of want) s.parked.add(g)
            else if (args?.action === 'mount') for (const g of want) s.parked.delete(g)
            const r = apply(agent)
            const head = args?.action === 'park' ? '已收起' : args?.action === 'mount' ? '已挂回' : '现状'
            const lines = [
              `tool_gate：${head} —— 收起中：${r.parked.length ? r.parked.join(', ') : '（无，全套都在）'}`,
              r.deny.length
                ? `摘掉 ${r.deny.length} 个工具：${r.deny.slice(0, 10).join(', ')}${r.deny.length > 10 ? ' …' : ''}`
                : '没有工具被摘掉。',
              r.lastError ? `⚠️ restrict 失败：${r.lastError}` : '下一个 step 的工具表生效。',
            ]
            return { ok: true, text: lines.join('\n') }
          },
        }),
      )
      probe('register ok')
    } catch (err) {
      probe(`register ERR ${err && (err.stack || err.message || err)}`)
    }
  }

  probe(`constructed parked=${JSON.stringify(config?.parked ?? null)}`)

  // 必须显式等 tools 就绪：模块级 `inject` 不保证构造这一刻 ctx.tools 可读。
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['tools'], (c) => {
      probe('inject callback')
      start(c ?? ctx)
    })
  } else {
    start(ctx)
  }
}
