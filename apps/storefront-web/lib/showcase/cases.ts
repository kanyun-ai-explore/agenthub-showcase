/**
 * 场景注册表——整个站点的扩展点。
 *
 * 两层：**场景**（电商 / 在线教育 / 语言学习）下面挂若干**视角**，一个视角 = 一个 agent + 一块
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
export type SurfaceApp = "shopping" | "merchant" | "wechat" | "classroom" | "english" | "roleplay";

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
    blurb: "一个可以对话的商城。消费者侧是导购助手，商家侧是商家助手，两边共用一个后端。",
    surfaces: [
      {
        id: "shopping",
        name: "导购助手",
        persona: "消费者",
        tagline: "会聊天的商城：说需求，它给方案",
        intro:
          "左边是一个完整的购物 App，首页、分类、详情、购物车都可以点。中间那颗按钮打开的 AI 导购接在同一个后端上：它调用商品检索、订单查询、购物车这些真实工具，再用生成式 UI 把结果渲染成卡片，可以直接在卡片上加购。它还会记住你说过的偏好，下次不用重复说明。",
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
        capabilityOverrides: {
          mcp: {
            blurb: "业务能力以 MCP Server 的形式注册到平台，Agent 文件按 ID 引用即可调用。这个视角的 20 个商品、订单和购物车工具就是这样接入的。",
          },
          "generative-ui": {
            blurb: "Agent 不只回复文本：它调用 present_* 工具返回结构化数据，前端按组件名渲染成商品卡、对比表、清单和订单状态。同一份数据换一个端，可以渲染成另一套界面。",
          },
        },
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
          "同一个平台上的第二个 Agent，面向商家。问一句就能拿到经营快照、库存告警和滞销盘点，还能直接拟出调价和促销方案。但它不会自己改线上数据：所有写操作先生成待审改动，人在审批页点了同意才生效。",
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
            blurb: "业务能力以 MCP Server 的形式注册到平台，Agent 文件按 ID 引用即可调用。这个视角的 22 个指标、库存和改动工具就是这样接入的。",
            evidence: "mcpServers: vcrd_…（merchant stdio MCP）",
          },
          "generative-ui": { evidence: "present_metrics / present_digest / present_change_preview" },
          "backend-contract": {
            blurb: "沙箱里的 Agent 可以回调你自己的 HTTP 接口。在这个视角里，Agent 拟好的每一条改动都通过这种方式镜像回这个 App 的审批队列。",
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
      { title: "服饰与美妆", body: "把尺码、肤质、过敏原写进记忆，下一次直接按人推荐，而不是每次从头问一遍。" },
      { title: "旅行与票务", body: "一句「国庆带娃去大理」拆成航班、酒店、行程三段方案，每段都是可下单的卡片。" },
      { title: "复杂决策型商品", body: "保险、装修、B 端选型这类需要对比和解释的场景，对比表和依据清单本来就是 Agent 的原生输出。" },
      { title: "运营与供应链", body: "补货、调拨、清仓、调价由 Agent 拟稿，人只做同意或驳回。决策速度提高，控制权不下放。" },
    ],
  },
  {
    id: "education",
    name: "在线教育",
    icon: "教",
    blurb: "一个 AI 教研团队：课程顾问、数学老师、语文老师、批改助手和学情分析师，五个 Agent 各司其职。",
    surfaces: [
      {
        id: "course-sales",
        name: "课程顾问",
        persona: "家长",
        tagline: "在微信里就把课选完了",
        intro:
          "家长不会为了咨询一门课再装一个 App，所以这个视角做成了微信的样子。顾问「小豆」聊的是真实的运营口径：开课时间、分班规则、退款政策都写在它的记忆文档里，随发布冻结，改动走 git review，不是模型现编的。聊到方案和试听时，它把课程卡和排期卡直接插进对话里。",
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
            blurb: "课程目录、价格、试听排期这些业务数据通过 MCP 工具接入，顾问靠查询作答，不靠背。",
            evidence: "get_course_catalog / get_trial_slots",
          },
          "generative-ui": { evidence: "present_course_plan / present_trial_slots" },
          memory: {
            blurb: "运营口径写在 memory/ 里，随发布冻结。开课时间、最短购课周期、退款规则改一次就全网生效，不用重新训练，也不用改提示词。",
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
          "这是生成式 UI 最直接的一个演示：豆豆老师（那只戴眼镜的小章鱼）不是返回一段文字让你自己读，而是在驱动一块教学界面。每一页课件都是它现编的，标题、讲解、教具和练习题通过 present_slide / present_exercise 传过来，App 只负责绘制。你点的答案会作为下一轮输入回传给它，它据此决定继续讲，还是退回去换个说法再讲一遍。",
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
            blurb: "教学大纲和学生进度通过 MCP 工具接入，出一页课件也是一次工具调用，所以对平台来说，「上课」和「查订单」没有区别。",
            evidence: "get_lesson / present_slide / present_exercise / get_student_progress",
          },
          "generative-ui": {
            blurb: "present_slide 传的是结构化的页面内容（标题、讲解、教具类型和数字），不是 HTML。同一个 Agent 换一个端（大屏、平板、小程序），可以渲染成完全不同的课堂。",
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
        tagline: "同一学生切课，不冷启动",
        intro:
          "这个视角验证跨 Agent 的预热与切换：你在数学课（豆豆老师）的会话就绪后，页面会为同一个访客身份预先建好语文课（乐乐老师）的会话；切到语文课时直接复用那个已经就绪的会话，不用再冷启动。反向也一样，从语文课切回数学课同样不冷启动。学生进任一门课时，平台都为同一身份预热另一门课的 Agent，切课即开讲。",
        agent: "chinese-tutor",
        app: "classroom",
        meta: [
          { label: "Agent", value: "edu-chinese-tutor" },
          { label: "课件", value: "Agent 逐页现编" },
          { label: "切换", value: "同一学生从数学课切过来不冷启动" },
        ],
        capabilities: ["file-agent", "sandbox", "mcp", "generative-ui", "session-turn", "stream", "config-values", "memory"],
        capabilityOverrides: {
          "file-agent": { evidence: "agenthub/agents/edu-chinese-tutor/agent.yaml + CLAUDE.md" },
          mcp: {
            blurb: "教学内容和学生进度通过 MCP 工具接入，出一页课件也是一次工具调用，所以对平台来说，「上课」和「查订单」没有区别。",
            evidence: "present_slide / present_exercise / get_student_progress",
          },
          "generative-ui": {
            blurb: "present_slide 传的是结构化的页面内容（标题、讲解、教具类型和文字），不是 HTML。同一个 Agent 换一个端（大屏、平板、小程序），可以渲染成完全不同的课堂。",
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
          "把题目和自己写的答案发过来，它先看你做到哪一步、卡在哪里，再决定给多深的提示：第一层是小提示，还不会才给第二层，完整解法永远是最后一步。批改结果渲染成卡片，标出哪题对、哪题错、错在哪一步。连续三次卡在同一个知识点时，它会把你转回豆豆老师那里重讲，而不是自己换一种讲法。",
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
          "这个视角演示的是一条硬边界：所有数字必须来自沙箱里跑的 Python 管线，模型不得对原始数据心算、目测、抽样估算，哪怕你只问「大概」。管线跑不了，就如实说跑不了。模型的价值在语义层：解读数据、指出需要行动的信号、把统计结果翻译成老师能据此行动的话。周报有 JSON Schema 契约，前端按契约渲染。",
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
            blurb: "这个视角最能说明为什么要沙箱：Agent 在沙箱里真的跑一个 Python 数据管线，读 CSV、算正确率、生成周报文件，不是让模型对着数据猜。",
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
      { title: "K12 与素质教育", body: "换一套课件和知识点图谱，上课、批改、学情这套结构可以直接搬到科学、编程、乐器。" },
      { title: "企业培训与认证", body: "课件换成合规培训，练习换成考核题，学情周报换成部门通过率，结构完全一样。" },
      { title: "招生与续报", body: "顾问 Agent 的口径写在记忆文档里，运营改一次就全网生效，不用挨个培训销售。" },
      { title: "教研提效", body: "学情分析从周报里挑出「哪个知识点全班都卡住」这类信号，教研直接拿去改课件。" },
    ],
  },
  {
    // 英语小课和情景对话原先挂在在线教育下面。旧路径 /showcase/education/<id>
    // 在 next.config.ts 里 308 到这里：findSurface 对不认识的视角 id 回落到第一个视角，
    // 不重定向的话旧链接会 200 打开课程顾问，而不是报错。
    id: "language",
    name: "语言学习",
    icon: "语",
    blurb: "两种练英语的方式：英语小课按闯关式的路径图一关一关做题，每关的题由 Agent 现场出；情景对话按住说英语，跟咖啡店店员聊几句。",
    surfaces: [
      {
        id: "english-course",
        name: "英语小课",
        persona: "一年级学生",
        tagline: "一关的题由 Agent 现场出，下一关照你错过的题出",
        intro:
          "这里做了一套闯关式的课程页：路径图上一个单元四关，点一关进去是一屏一题。选、拼、检查、继续都在页面本地完成，判定条和音效当场出来，不等模型。Agent 只在几个时刻出场：开一关时调 present_lesson 分两批交题（先 2 道、再 6 道），第 1 批的 2 道一到就能答；做完一关，页面把对错汇总发给它，它回一句点评，并在同一轮里照你错过的点出下一关；答错后点「为什么」才显示它的讲解；跟读题按住读一句，松手后页面先量一下音量，几乎无声的一段不发送，也不占每分钟 10 次的额度，只提示「没听到声音，按住再读一次」；有声音才走平台的语音回合，先把录音转写成文字，页面立刻逐词比对（读对绿、读错红、漏读灰），它的文字点评要点「看点评」才显示。会话同一时刻只跑一个回合，这些请求在页面里排队。听音题的读音由站点自建的 TTS 合成，题一到就预取。跟读不打发音分（转写会顺手纠错，结果偏乐观）。通关、XP 和连胜只写在这台设备的浏览器里，这个视角的定位是能力的 showcase，不是完整应用。",
        agent: "english-coach",
        app: "english",
        meta: [
          { label: "Agent", value: "edu-english-coach" },
          { label: "出题", value: "整关出题（present_lesson）" },
          { label: "下一关", value: "照上一关的错题出" },
          { label: "语音回合", value: "跟读转写 + 文字点评" },
          { label: "进度", value: "只存本机 localStorage" },
        ],
        // 没有列「记忆」：这个 agent 的工具面只有 Skill + mcp__course（见 agent.yaml 的
        // allowedTools），记忆走平台注入的记忆工具，不是它自己挂的工具；而能力卡片的
        // 点亮判据沿用的是基表里的 save_memory / recall_memories ——在这个视角上永远亮不了。
        // 摆一条亮不起来的卡，等于替它说一句自己核不到的话。数学课/语文课两处 memory override
        // 也有同一问题，还没改。
        capabilities: ["file-agent", "sandbox", "mcp", "generative-ui", "session-turn", "stream", "config-values", "voice-turn"],
        capabilityOverrides: {
          "file-agent": { evidence: "agenthub/agents/edu-english-coach/agent.yaml + CLAUDE.md" },
          mcp: {
            blurb: "出题就是 MCP 调用：present_lesson 把一批题作为一个数组交给页面（开一关分两批，结算时把下一关一批出齐）。这个课程 MCP 和在线教育那五个 Agent 挂的是同一个，跨两个场景共用。出题和查订单、读周报在平台上没有区别。",
            evidence: "present_lesson({ lesson_id, batch, batches, exercises: [...] }) · mcpServers: vcrd_…（与在线教育同一个）",
          },
          "generative-ui": {
            blurb: "一关的题传的是结构，不是 HTML：题型、词库、正确语序、选项下标都是数据，页面拿到后本地判分、本地推进。换一个端（大屏、平板、小程序），可以渲染成完全不同的课程页。",
            evidence: 'present_lesson → { component: "lesson", payload: { exercises } }',
          },
          stream: {
            blurb: "讲解、点评点开时如果还在生成，就接会话的事件流逐字显示；出题时按流的阶段（准备 / 在想 / 在写题）给等待提示，第一批题的入参一到就开答。回合结束仍由 waitForTurn 判定。",
            evidence: "sessions.streamEvents → /api/agenthub/stream",
          },
          "voice-turn": {
            blurb:
              "跟读这一题是语音回合：按住录一段（几乎无声的一段在页面上就拦下、不发），平台先转写成文字再交给 Agent（它拿到的和打字一样）。站点派发后立刻把转写交回页面，逐词比对当场画出来；Agent 的一句文字点评后到，不挡「继续」。"
              + "限额也来自平台契约：每会话每分钟 10 次、单段 60 秒 / 2 MB。",
            evidence: "sessions.sendVoiceTurn → turns.get（转写先回）/ waitForTurn（点评）",
          },
        },
        // 路径图版没有开场白按钮（进页面就建会话、预出第一关），这里留空。
        openers: [],
        agentFile: "agenthub/agents/edu-english-coach/agent.yaml",
        snippet: `# CLAUDE.md 里的上法（节选）
# 1. 【出题】分两批调 present_lesson（同一个 lesson_id，先 2 道、再 6 道），四种题型混排，正文留空
# 2. 【结算】先回一句中文点评，再调 present_lesson 把下一关一批出齐——专门练这一关错过的点
# 3. 【为什么】一两句中文讲这一题；跟读的转写回一两句文字点评；这两种都不调工具

mcpServers:
  - vcrd_………                    # 教育 MCP：课件/展示（含 present_lesson）

voice:                          # 跟读：语音回合只做转写，点评是文字（不声明 output）
  input: { provider: modelgate, model: qwen3-asr-flash, language: en }`,
      },
      {
        id: "roleplay",
        name: "情景对话",
        persona: "一年级学生",
        tagline: "跟咖啡店店员用英语聊三四句",
        intro:
          "同一个科目换一种练法：这次不是做题，而是把刚学的句子用出去。手机里是一家咖啡店，店员 Sam 是一个 format: live 的 Agent：他不建沙箱、不烘焙镜像，会话只由「定义文档 + 模型服务」组成，所以开口快；代价是他调不了任何工具，小结卡是前端从你们的对话里自己算出来的。按住按钮说英语，平台先把你的话转写成文字交给他，他回的那句再被合成为语音播放出来（对讲机式的半双工：按住才录，松手就发）。三四轮之后看小结：说了几句、用到了哪些句型、点到了哪几个词。不打分，也不评发音（转写会顺手把读音纠成正确的词，评不准）。",
        agent: "roleplay",
        app: "roleplay",
        meta: [
          { label: "Agent", value: "edu-english-roleplay" },
          { label: "运行时", value: "format: live（不建沙箱）" },
          { label: "回合", value: "语音：转写 + 合成" },
          { label: "小结", value: "前端从对话里算（不打分）" },
        ],
        // 没有列「独立沙箱运行时 / 托管 MCP / 生成式 UI」：live 运行时恒不具备这三样，
        // 列上去等于在时间线和能力面板上摆三条永远亮不起来的卡。这正是这个视角要展示的
        // 区别——首字快的代价就是这些都没有。
        capabilities: ["file-agent", "live", "session-turn", "stream", "config-values", "model-gate", "voice-turn"],
        capabilityOverrides: {
          "file-agent": { evidence: "agenthub/agents/edu-english-roleplay/agent.yaml + CLAUDE.md" },
          "voice-turn": {
            blurb:
              "对话的每一轮都是一个语音回合：你的录音由平台先转写再交给 Agent，Agent 回的那句话被合成为分段音频播放出来。"
              + "限额也来自平台契约：每会话每分钟 10 次、单段 60 秒 / 2 MB。",
            evidence: "agenthub/agents/edu-english-roleplay/agent.yaml + voice: input/output",
          },
        },
        openers: ["我走进咖啡店，开始点单"],
        agentFile: "agenthub/agents/edu-english-roleplay/agent.yaml",
        snippet: `apiVersion: agenthub/v1alpha1
format: live                     # 不建沙箱：没有 environment / mcpServers / agentOptions
modelService: model              # live 臂必填：会话要在创建时冻结一个项目级模型服务
model: gemini-3.1-flash-lite

voice:                           # 转写在派发前、合成在回合终态后
  input:  { provider: modelgate, model: qwen3-asr-flash, language: en }
  output: { provider: modelgate, model: qwen3-tts-flash, voice: Cherry, format: mp3 }

memory:
  enabled: false                 # 上下文全在这一条会话里，不花记忆召回那一趟`,
        lessonTitle: "咖啡店",
        teacherName: "Sam",
        welcomeText: "你走进一家咖啡店，店员 Sam 在柜台后面。点一下开始，他会先跟你打招呼。",
      },
    ],
    extensions: [
      { title: "更多语种", body: "换一份出题规则和词库，同一套路径图和一屏一题的形式可以用来教日语、西班牙语。" },
      { title: "更多对话场景", body: "咖啡店换成面试、开会、问路，同样是按住说、松手听的一来一回。" },
      { title: "学习记录", body: "通关、XP 和连胜现在只存在这台设备的浏览器里；接上记忆或业务后端，就能按周汇总给家长或老师看。" },
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
  { title: "已有系统封装成工具", body: "任何 HTTP 接口、内部服务、数据库查询都能封装成 MCP Server 注册进来，Agent 文件引用一行 ID 就能用。" },
  { title: "一个 Agent 多个端", body: "生成式 UI 返回的是结构化数据，不是 HTML。App、Web、企业微信、大屏各自渲染，Agent 只写一次。" },
  { title: "风险动作有闸门", body: "读操作放开、写操作审批、敏感操作双人确认。审批策略是平台机制，不靠每个 Agent 作者自觉。" },
  { title: "像发代码一样发 Agent", body: "Agent 定义进 git，走 PR 和流水线，冻结成版本后按 Stage 分别发布，出问题可以回滚到上一版。" },
];
