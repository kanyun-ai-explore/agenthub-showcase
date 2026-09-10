/**
 * 场景注册表——整个站点的扩展点。
 *
 * 两层：**场景**（电商 / 在线教育）下面挂若干**视角**，一个视角 = 一个 agent + 一块
 * 手机端界面。加视角是加一条记录 + 一个手机端组件；加场景是加一条记录。导航、路由、
 * 能力面板都读这里，没有第三处要改。
 *
 * 纯数据不含 React，服务端和客户端组件都能 import（组件映射在 CaseStage 里）。
 */

import type { AgentKey } from "@/lib/agenthub/client";
import type { Capability, CapabilityId } from "./capabilities";

export interface CaseExtension {
  title: string;
  body: string;
}

/** 手机里放哪块界面。 */
export type SurfaceApp = "shopping" | "merchant" | "wechat" | "classroom";

export interface Surface {
  id: string;
  name: string;
  persona: string;
  tagline: string;
  intro: string;
  agent: AgentKey | null;
  app: SurfaceApp;
  meta: { label: string; value: string }[];
  capabilities: CapabilityId[];
  /**
   * 这个视角专有的措辞修正。能力目录存通用文案，但**出处**是视角专有的：把商家面板
   * 指向 cma-shopping 的文件是错引，而在一个论点是「你去核」的页面上，错引比缺引贵。
   */
  capabilityOverrides?: Partial<Record<CapabilityId, Partial<Pick<Capability, "blurb" | "evidence">>>>;
  /** 预置示例问题。渲染成页面文案，绝不做成 agent 输出的样子。 */
  openers: string[];
  agentFile: string;
  snippet: string;
  /** 本会话 ready 后，页面为同一访客预建这些 agent 的会话，验证跨 agent 切换。 */
  prewarm?: AgentKey[];
  /** 上课界面顶部显示的课名；缺省回落 lesson?.title，再缺省「数学课」。 */
  lessonTitle?: string;
  /** 上课界面欢迎屏的老师名 / 开场白；缺省是数学课的豆豆老师。 */
  teacherName?: string;
  welcomeText?: string;
}

export interface Scenario {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  surfaces: Surface[];
  extensions: CaseExtension[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "commerce",
    name: "电商",
    icon: "商",
    blurb: "一个会聊天的商城。消费者侧是导购，商家侧是运营助手，两边共用一个后端。",
    surfaces: [
      {
        id: "shopping",
        name: "导购助手",
        persona: "消费者",
        tagline: "会聊天的商城：说需求，它给方案",
        intro:
          "左边是一个完整的购物 App——首页、分类、详情、购物车都能点。中间那颗按钮打开的 AI 导购接在同一个后端上：它调用商品检索、订单查询、购物车这些真实工具，再用生成式 UI 把结果渲染成卡片，你可以直接在卡片上加购。它还记得住你说过的偏好，下次不用重说。",
        agent: "shopping",
        app: "shopping",
        meta: [
          { label: "Agent", value: "cma-shopping" },
          { label: "工具", value: "20 个 MCP 工具" },
          { label: "UI 组件", value: "8 种生成式卡片" },
        ],
        capabilities: [
          "file-agent", "sandbox", "mcp", "generative-ui", "session-turn",
          "stream", "config-values", "backend-contract", "memory", "recovery",
        ],
        openers: [
          "我要去山里露营三天，预算 2000 块左右，帮我配一套装备",
          "把这两个头灯对比一下，哪个更适合长时间夜跑？",
          "我上次买的那个咖啡机，还能再来一台吗？",
        ],
        agentFile: "agenthub/agents/cma-shopping/agent.yaml",
        snippet: `apiVersion: agenthub/v1alpha1
format: claude_code
model: deepseek-v4-flash
environment: cma-python          # 依赖预装在平台 Environment 里

mcpServers:
  - vcrd_…                       # 商城 MCP：检索/订单/购物车/展示

agentOptions:
  maxTurns: 16
  allowedTools: [Skill, Read, mcp__storefront]`,
      },
      {
        id: "merchant",
        name: "商家助手",
        persona: "商家运营",
        tagline: "看得懂经营数据，还能替你把改动拟好",
        intro:
          "同一个平台上的第二个 Agent，换了一副身份：面向商家。开口就能拿到经营快照、库存告警、滞销盘点，还能直接拟出调价和促销方案。但它不会自己改线上数据——所有写操作先落成待审改动，人在审批页点了同意才生效。",
        agent: "merchant",
        app: "merchant",
        meta: [
          { label: "Agent", value: "cma-merchant" },
          { label: "工具", value: "22 个 MCP 工具" },
          { label: "写操作", value: "全部人工审批" },
        ],
        capabilities: [
          "file-agent", "sandbox", "mcp", "generative-ui", "session-turn",
          "stream", "backend-contract", "human-approval", "recovery",
        ],
        capabilityOverrides: {
          "file-agent": { evidence: "agenthub/agents/cma-merchant/agent.yaml + CLAUDE.md" },
          mcp: {
            blurb: "业务能力以 MCP Server 形式注册到平台，Agent 文件按 id 引用即可调用。这个视角的 22 个指标/库存/改动工具就是这么接进来的。",
            evidence: "mcpServers: vcrd_…（merchant stdio MCP）",
          },
          "generative-ui": { evidence: "present_metrics / present_digest / present_change_preview" },
          "backend-contract": {
            blurb: "沙箱里的 Agent 可以回调你自己的 HTTP 接口。这个视角里，它拟好的每一条改动都是这样镜像回这个 App 的审批队列的。",
            evidence: "BACKEND_BASE_URL → /api/changes/mirror · /api/changes/approved-ids",
          },
        },
        openers: [
          "今天店铺经营情况怎么样？",
          "哪些商品快断货了，帮我看一下",
          "给露营帐篷做个限时促销，别把毛利做穿",
        ],
        agentFile: "agenthub/agents/cma-merchant/agent.yaml",
        snippet: `mcpServers:
  - id: vcrd_…                   # 商家 MCP：指标/库存/改动
    tools:
      - name: query_metrics
      - name: stage_price_update  # 只落待审，不直接改
      - name: apply_change        # 批准后才执行

env:
  BACKEND_BASE_URL: https://…/api  # 审批回环打到这个 App`,
      },
    ],
    extensions: [
      { title: "服饰与美妆", body: "把尺码、肤质、过敏源写进记忆，下一次直接按人推荐，而不是每次从头问一遍。" },
      { title: "旅行与票务", body: "一句「国庆带娃去大理」拆成航班、酒店、行程三段方案，每段都是可下单的卡片。" },
      { title: "复杂决策型商品", body: "保险、装修、B 端选型这类要对比要解释的场景，对比表和依据清单本来就是它的原生输出。" },
      { title: "运营与供应链", body: "补货、调拨、清仓、调价由 Agent 拟稿，人只做同意或驳回——决策速度上来，控制权不下放。" },
    ],
  },
  {
    id: "education",
    name: "在线教育",
    icon: "教",
    blurb: "一个 AI 教研团队：课程顾问、数学老师、语文老师、批改助手、学情分析师，五个 agent 各司其职。",
    surfaces: [
      {
        id: "course-sales",
        name: "课程顾问",
        persona: "家长",
        tagline: "在微信里就把课选完了",
        intro:
          "家长不会为了咨询一门课再装一个 App，所以这个视角就长成微信的样子。顾问「小豆」聊的是真实的运营口径——开课时间、分班规则、退款政策都写在它的记忆文档里，随发布冻结、改动走 git review，不是模型现编的。聊到方案和试听时，它把课程卡和排期卡直接插进对话里。",
        agent: "course-sales",
        app: "wechat",
        meta: [
          { label: "Agent", value: "edu-course-sales" },
          { label: "界面", value: "微信对话" },
          { label: "口径来源", value: "记忆文档，随发布冻结" },
        ],
        capabilities: ["file-agent", "sandbox", "mcp", "generative-ui", "session-turn", "stream", "config-values", "memory"],
        capabilityOverrides: {
          "file-agent": { evidence: "agenthub/agents/edu-course-sales/agent.yaml + CLAUDE.md" },
          mcp: {
            blurb: "课程目录、价格、试听排期这些业务数据以 MCP 工具接进来，顾问不靠背，靠查。",
            evidence: "get_course_catalog / get_trial_slots",
          },
          "generative-ui": { evidence: "present_course_plan / present_trial_slots" },
          memory: {
            blurb: "运营口径写在 memory/ 里随发布冻结：开课时间、最短购课周期、退款规则改一次全网生效，不用重训也不用改提示词。",
            evidence: "memory/default.md · memory/autumn-2026.md",
          },
        },
        openers: [
          "孩子今年上一年级，数学有点跟不上，你们有什么课？",
          "能先试听吗？大概什么时候有空位",
          "如果上了几节觉得不合适，能退吗？",
        ],
        agentFile: "agenthub/agents/edu-course-sales/agent.yaml",
        snippet: `apiVersion: agenthub/v1alpha1
format: claude_code
model: claude-sonnet-5

mcpServers:
  - vcrd_………                    # 教育 MCP：课程目录/排期/展示

# 运营口径不写进提示词，写成随发布冻结的记忆文档
memory:
  enabled: true`,
      },
      {
        id: "math-tutor",
        name: "数学课",
        persona: "一年级学生",
        tagline: "Agent 不是在回答，是在上课",
        intro:
          "这是生成式 UI 最直白的一个演示：豆豆老师（那只戴眼镜的小章鱼）不返回一段文字让你自己读，它在驱动一块教学界面——每一页课件都是它现编的，标题、讲解、教具、练习题通过 present_slide / present_exercise 传过来，App 只负责画。你点的答案会作为下一轮输入回给它，它据此决定继续讲，还是退回去换个说法再讲一遍。",
        agent: "math-tutor",
        app: "classroom",
        meta: [
          { label: "Agent", value: "edu-math-tutor" },
          { label: "课件", value: "Agent 逐页现编" },
          { label: "交互", value: "学生作答回流给 Agent" },
        ],
        capabilities: ["file-agent", "sandbox", "mcp", "generative-ui", "session-turn", "stream", "config-values", "memory"],
        capabilityOverrides: {
          "file-agent": { evidence: "agenthub/agents/edu-math-tutor/agent.yaml + CLAUDE.md" },
          mcp: {
            blurb: "教学大纲和学生进度以 MCP 工具接进来，出一页课件也是一个工具调用——所以「上课」这件事对平台来说和「查订单」没有区别。",
            evidence: "get_lesson / present_slide / present_exercise / get_student_progress",
          },
          "generative-ui": {
            blurb: "present_slide 传的是结构化的页面内容——标题、讲解、教具类型和数字——不是 HTML。同一个 agent 换个端（大屏、平板、小程序）可以画成完全不同的课堂。",
            evidence: "present_slide({ title, body, visual, kind }) / present_exercise({ prompt, options, answer_index })",
          },
          memory: {
            blurb: "孩子在哪个知识点上反复卡住会被记住，下次上课直接从那里切入。",
            evidence: "save_memory / recall_memories",
          },
        },
        openers: ["开始上课", "9 + 4 为什么等于 13？", "我还是不懂为什么要拆开"],
        agentFile: "agenthub/agents/edu-math-tutor/agent.yaml",
        snippet: `# CLAUDE.md 里的教学方式（节选）
# 1. 一次只讲一个知识点，讲完用一两道小题让孩子试着做
# 2. 答错先鼓励尝试，再引导他自己发现错在哪，不要直接甩答案
# 3. 答对了具体表扬他做对了什么，不要只说"真棒"

mcpServers:
  - vcrd_………                    # 教育 MCP：课件/进度/展示`,
        prewarm: ["chinese-tutor"],
        lessonTitle: "数学课",
      },
      {
        id: "chinese-tutor",
        name: "语文课",
        persona: "一年级学生",
        tagline: "同一学生切课，不冷启",
        intro:
          "这个视角验证跨 agent 预热与切换：你在数学课（豆豆老师）会话就绪后，页面会为**同一个访客身份**预先建好语文课（乐乐老师）的会话；切到语文课时直接复用那个已经就绪的会话，不用再冷启。反向也一样——从语文课切回数学课同样不冷启。学生进任一门课时，平台都为同一身份预热另一门课的 agent，切课即开讲。",
        agent: "chinese-tutor",
        app: "classroom",
        meta: [
          { label: "Agent", value: "edu-chinese-tutor" },
          { label: "课件", value: "Agent 逐页现编" },
          { label: "切换", value: "同一学生从数学课切过来不冷启" },
        ],
        capabilities: ["file-agent", "sandbox", "mcp", "generative-ui", "session-turn", "stream", "config-values", "memory"],
        capabilityOverrides: {
          "file-agent": { evidence: "agenthub/agents/edu-chinese-tutor/agent.yaml + CLAUDE.md" },
          mcp: {
            blurb: "教学内容和学生进度以 MCP 工具接进来，出一页课件也是一个工具调用——所以「上课」这件事对平台来说和「查订单」没有区别。",
            evidence: "present_slide / present_exercise / get_student_progress",
          },
          "generative-ui": {
            blurb: "present_slide 传的是结构化的页面内容——标题、讲解、教具类型和文字——不是 HTML。同一个 agent 换个端（大屏、平板、小程序）可以画成完全不同的课堂。",
            evidence: "present_slide({ title, body, visual, kind }) / present_exercise({ prompt, options, answer_index })",
          },
          memory: {
            blurb: "孩子在哪个知识点上反复卡住会被记住，下次上课直接从那里切入。",
            evidence: "save_memory / recall_memories",
          },
        },
        openers: ["开始上课", "b 和 p 怎么分", "妈 字怎么读"],
        agentFile: "agenthub/agents/edu-chinese-tutor/agent.yaml",
        snippet: `# CLAUDE.md 里的教学方式（节选）
# 1. 不要调用 get_lesson——它只有数学课大纲，备课大纲写在 CLAUDE.md 里
# 2. 拼音/识字用 objects 教具或 none，不要用 ten_frame / number_bond / steps

mcpServers:
  - vcrd_………                    # 教育 MCP：课件/进度/展示`,
        prewarm: ["math-tutor"],
        lessonTitle: "语文课",
        teacherName: "乐乐老师",
        welcomeText: "今天我们一起学拼音和认字。准备好了就点下面开始吧！",
      },
      {
        id: "homework-qa",
        name: "作业批改",
        persona: "学生 / 家长",
        tagline: "不直接给答案，一层一层给提示",
        intro:
          "把题目和自己写的答案发过来，它先看你做到哪一步、卡在哪里，再决定给多深的提示——第一层是小提示，还不会才给第二层，完整解法永远是最后一步。批改结果渲染成卡片：哪题对、哪题错、错在哪一步。连续三次卡在同一个知识点，它会把你转回豆豆老师那里重讲，而不是自己展开新讲法。",
        agent: "homework-qa",
        app: "wechat",
        meta: [
          { label: "Agent", value: "edu-homework-qa" },
          { label: "界面", value: "微信对话" },
          { label: "分工", value: "连错 3 次转回数学课" },
        ],
        capabilities: ["file-agent", "sandbox", "mcp", "generative-ui", "session-turn", "stream", "config-values", "memory"],
        capabilityOverrides: {
          "file-agent": { evidence: "agenthub/agents/edu-homework-qa/agent.yaml + CLAUDE.md" },
          mcp: { evidence: "present_correction / get_student_progress" },
          "generative-ui": { evidence: "present_correction" },
          memory: {
            blurb: "「连续 3 次同一知识点答错才转介」这类口径写在记忆文档里，是可审阅的运营规则，不是模型的临场判断。",
            evidence: "memory/known-facts.md",
          },
        },
        openers: [
          "8 + 7 我算成 14 了，哪里错了？",
          "这道题我不会做，能给点提示吗：9 + 6 = ?",
          "帮我看看这三题：9+4=13、8+5=14、7+6=12",
        ],
        agentFile: "agenthub/agents/edu-homework-qa/agent.yaml",
        snippet: `# CLAUDE.md 里的批改方式（节选）
# 3. 给提示按由浅到深来：先给一个小提示，孩子还是不会再给下一层，
#    最后一步才给出完整解法，不要一上来就把答案摆出来。
# 4. 图片描述看不清、题意有歧义时直接问孩子确认，不要凭猜测批改。`,
      },
      {
        id: "learning-analytics",
        name: "学情分析",
        persona: "老师 / 教研",
        tagline: "数字只能来自管线，解读才归模型",
        intro:
          "这个视角演示的是一条硬边界：**所有数字必须来自沙箱里跑的 Python 管线**，模型不许对原始数据心算、目测、抽样估算——哪怕你只问「大概」。管线跑不了就如实说跑不了。模型的价值在语义层：解读数据、指出该行动的信号、把统计翻译成老师能行动的话。周报有 JSON Schema 契约，前端照着渲染。",
        agent: "learning-analytics",
        app: "wechat",
        meta: [
          { label: "Agent", value: "edu-learning-analytics" },
          { label: "硬边界", value: "数字只来自管线" },
          { label: "输出契约", value: "weekly-report.schema.json" },
        ],
        capabilities: ["file-agent", "sandbox", "mcp", "generative-ui", "session-turn", "stream", "config-values"],
        capabilityOverrides: {
          "file-agent": { evidence: "agenthub/agents/edu-learning-analytics/agent.yaml + CLAUDE.md" },
          sandbox: {
            blurb: "这个视角最能说明「为什么要沙箱」：agent 在里面真的跑一个 Python 数据管线读 CSV、算正确率、生成周报文件，不是让模型对着数据猜。",
            evidence: "python3 -m learning_analytics",
          },
          mcp: { evidence: "get_weekly_report / present_report" },
          "generative-ui": { evidence: "present_report（照 weekly-report.schema.json）" },
        },
        openers: [
          "这周班级整体怎么样？",
          "哪个知识点最需要补？",
          "stu-003 这孩子最近是不是有问题",
        ],
        agentFile: "agenthub/agents/edu-learning-analytics/agent.yaml",
        snippet: `# CLAUDE.md 的核心分工（硬边界）
# - 数字只能来自 runtime/ 的 Python 管线（python3 -m learning_analytics）。
#   禁止对原始 CSV 心算、目测、抽样估算——哪怕用户只问"大概"。
#   管线跑不了就如实说跑不了，并给出报错原因。
# - 你的价值在语义层：解读数据、指出该行动的信号。

agentOptions:
  maxTurns: 60`,
      },
    ],
    extensions: [
      { title: "K12 与素质教育", body: "换一套课件和知识点图谱，同一套上课/批改/学情的结构可以直接搬到英语、编程、乐器。" },
      { title: "企业培训与认证", body: "课件换成合规培训，练习换成考核题，学情周报换成部门通过率——结构完全一样。" },
      { title: "招生与续报", body: "顾问 agent 的口径写在记忆文档里，运营改一次全网生效，不用挨个培训销售。" },
      { title: "教研提效", body: "学情分析把「哪个知识点全班都卡住」这种信号从周报里挑出来，教研直接拿去改课件。" },
    ],
  },
];

export const DEFAULT_SCENARIO_ID = "commerce";

export function findScenario(id: string | undefined): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export function findSurface(scenario: Scenario, id: string | undefined): Surface {
  return scenario.surfaces.find((s) => s.id === id) ?? scenario.surfaces[0];
}

/** 跨场景通用：平台在这类场景里给你的东西。 */
export const PLATFORM_EXTENSIONS: CaseExtension[] = [
  { title: "已有系统包成工具", body: "任何 HTTP 接口、内部服务、数据库查询都能包成 MCP Server 注册进来，Agent 文件引一行 id 就能用。" },
  { title: "一个 Agent 多个端", body: "生成式 UI 返回的是结构化数据不是 HTML。App、Web、企微、大屏各渲染各的，Agent 只写一次。" },
  { title: "风险动作有闸门", body: "读操作放开、写操作审批、敏感操作双人确认——审批策略是平台机制，不靠每个 Agent 作者自觉。" },
  { title: "像发代码一样发 Agent", body: "Agent 定义进 git，走 PR、走流水线、冻结成版本、分环境发布，出问题可以回滚到上一版。" },
];
