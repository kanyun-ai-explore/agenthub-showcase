/**
 * 右栏解释的平台能力目录。
 *
 * 每条的 `evidence` 都指向本仓库里证明它的那个文件或字段，读者可以去核。做不到的
 * 不写在这里，写进「还能这样用」。`signal` 是让它打勾的运行时事件；`signal: null`
 * 的条目只解释、永不打勾——不打勾是诚实的，被无关事件点亮不是。
 */

export type CapabilityId =
  | "file-agent"
  | "sandbox"
  | "mcp"
  | "generative-ui"
  | "session-turn"
  | "stream"
  | "config-values"
  | "backend-contract"
  | "human-approval"
  | "recovery"
  | "memory"
  | "model-gate";

/** 页面真的能观察到的运行时事件。 */
export type CapabilitySignal =
  | "session-created"
  | "sandbox-ready"
  | "stream-chunk"
  | "tool-call"
  | "present-card"
  | "revival";

export interface Capability {
  id: CapabilityId;
  name: string;
  /** 一句话，业务同学能复述的那种。 */
  blurb: string;
  /** 本仓库里的出处，页面直接显示。 */
  evidence: string;
  signal: CapabilitySignal | null;
  /**
   * 能证明这条能力的具体工具名。填了之后光有 signal 不够，必须其中一个真的被调用过。
   * 最早「记忆」挂在裸 `tool-call` 上，`search_products` 一调它就亮，等于告诉观众
   * agent 用了记忆——它没有。虚报的能力面板比没有面板更糟。
   */
  tools?: string[];
}

export const CAPABILITIES: Record<CapabilityId, Capability> = {
  "file-agent": {
    id: "file-agent",
    name: "文件定义 Agent",
    blurb:
      "Agent 的模型、工具、系统提示词全部是仓库里的文件，跟着 git 走，改动经流水线冻结成版本再发布——不是在控制台里点出来的一次性配置。",
    evidence: "agenthub/agents/cma-shopping/agent.yaml + CLAUDE.md",
    signal: "sandbox-ready",
  },
  sandbox: {
    id: "sandbox",
    name: "独立沙箱运行时",
    blurb:
      "每个会话拿到一个隔离容器，依赖由平台 Environment 预装。Agent 在里面跑真实进程、读文件、起子进程，不是一次无状态的模型调用。",
    evidence: "environment: cma-python（预装 pydantic / mcp / httpx）",
    signal: "sandbox-ready",
  },
  mcp: {
    id: "mcp",
    name: "托管 MCP 工具",
    blurb:
      "业务能力以 MCP Server 形式注册到平台，Agent 文件按 id 引用即可调用。这个案例的 20 个商品/订单/购物车工具就是这么接进来的。",
    evidence: "mcpServers: vcrd_…（storefront stdio MCP）",
    signal: "tool-call",
  },
  "generative-ui": {
    id: "generative-ui",
    name: "生成式 UI",
    blurb:
      "Agent 不只回文本：它调用 present_* 工具返回结构化数据，前端按组件名渲染成商品卡、对比表、清单、订单状态。同一份数据换个端就是另一套皮。",
    evidence: "present_products / present_comparison / present_plan …",
    signal: "present-card",
  },
  "session-turn": {
    id: "session-turn",
    name: "会话与 Turn API",
    blurb:
      "一行 SDK 建会话、发一轮对话、等它终态返回。会话是一等实体，历史可回放，turn 可中止，不需要自己维护上下文。",
    evidence: "@kanyun-ai-infra/agenthub · sessions.create / sendTurn / waitForTurn",
    signal: "session-created",
  },
  stream: {
    id: "stream",
    name: "流式输出",
    blurb:
      "SSE 逐字回显 Agent 正在写的内容，同时用 waitForTurn 判定终态——渲染和控制分开，长连接被网关切断也能带游标续上。",
    evidence: "sessions.streamEvents(sessionId, { lastEventId })",
    signal: "stream-chunk",
  },
  "config-values": {
    id: "config-values",
    name: "每会话配置注入",
    blurb:
      "用户身份、租户、会话号这些每次都不同的值，建会话时注入，不写死在 Agent 文件里。同一个 Agent 版本服务所有用户。",
    evidence: "shopping: 预热池暖机时铸 EUID → PILOT_END_USER_ID；冷启时 sessions.create 带 user:{ id } 带入",
    signal: "session-created",
  },
  "backend-contract": {
    id: "backend-contract",
    name: "反向调用业务后端",
    blurb:
      "沙箱里的 Agent 可以回调你自己的 HTTP 接口。所以它读写的是这个 App 真实的购物车和订单，而不是它自己脑补的一份数据。",
    evidence: "BACKEND_BASE_URL → apps/storefront-web/app/api/backend/*",
    signal: "tool-call",
    tools: [
      // shopping: these reach this app's own cart/order routes over contract (a)
      "get_cart", "add_to_cart", "update_cart_item", "remove_from_cart",
      "get_orders", "get_order_status", "get_preferences",
      // merchant: every stage_* mirrors into this app's approval queue (contract b)
      "stage_listing_update", "stage_price_update", "stage_inventory_action",
      "stage_promotion", "stage_campaign", "apply_change",
    ],
  },
  "human-approval": {
    id: "human-approval",
    name: "写操作人工审批",
    blurb:
      "Agent 的写操作先落成待审改动，人在审批页确认后才真正生效。每次 apply 前重新拉一遍已批准集合，拒绝时默认不执行。",
    evidence: "stage_* → /operator 审批 → apply_change",
    signal: "tool-call",
    tools: [
      "stage_listing_update", "stage_price_update", "stage_inventory_action",
      "stage_promotion", "stage_campaign", "apply_change", "discard_change",
    ],
  },
  recovery: {
    id: "recovery",
    name: "会话回收与恢复",
    blurb:
      "闲置会话的算力会被回收以省成本；用户再开口时平台自动把沙箱拉起来接着聊，上下文不丢。",
    evidence: "pendingRevival / revival_in_progress",
    signal: "revival",
  },
  memory: {
    id: "memory",
    name: "记忆",
    blurb: "Agent 可以把用户偏好写进记忆，下次对话直接召回——这个案例里是尺码、预算、忌口这类长期事实。",
    evidence: "save_memory / recall_memories",
    signal: "tool-call",
    tools: ["save_memory", "recall_memories"],
  },
  "model-gate": {
    id: "model-gate",
    name: "统一模型接入",
    blurb: "换模型是改 Agent 文件里的一行。模型网关统一鉴权、限流、计费，业务侧不接触厂商 SDK。",
    evidence: "model: deepseek-v4-flash",
    signal: null,
  },
};

export function capability(id: CapabilityId): Capability {
  return CAPABILITIES[id];
}
