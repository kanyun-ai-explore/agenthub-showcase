# AgentHub Showcase

**AgentHub 的目标：让 Agent 交付效率提升 10 倍。**

把角色、技能和业务工具交给开发者，把运行环境、模型接入、版本发布和会话管理交给平台，
让团队把更多时间用在业务效果上。从定义一个 Agent，到把它交付进应用，AgentHub 提供一条统一的构建与运行路径。

这些 Agent 可以走进怎样的业务场景？

它可以帮顾客比较商品、把选中的装备放进购物车，也可以为商家分析经营数据、拟好待审批的改动；
它可以为家长推荐课程，为孩子逐页讲解知识点、根据作答调整教学，再把学习数据整理成老师能采取行动的周报。

这里收录了使用 **AgentHub 构建的应用案例**。目前包含电商和在线教育两个 case，后续会继续扩展。
每个案例都公开了 Agent 定义、业务工具和交互界面的源码，可以从一个具体效果，一路看到它在 AgentHub 上的实现。

**[进入 AgentHub](https://agenthub.zhenguanyu.com/921b91f0-e49a-4733-ab7c-c7fd66f01941/sessions) · [电商案例](#电商从选购到经营) · [在线教育案例](#在线教育从咨询到课堂) · [如何构建](#如何在-agenthub-上构建)**

## 电商：从选购到经营

这个 case 来自 Anthropic 开源的 **[commerce-agents（CMA）](https://github.com/anthropics/commerce-agents)**，
包含面向顾客的导购 Agent 和面向商家运营的商家 Agent。

**以 CMA 为应用能力参照，在 AgentHub 上交付同类业务体验。**
我们沿用 CMA 的角色分工、技能、业务工具契约和护栏，把它们接入 AgentHub 的文件定义 Agent 与 MCP 运行方式。
这也体现了 AgentHub 的构建理念：Agent 的业务定义可以复用，发布和运行由平台统一承接。

[查看 CMA 原项目](https://github.com/anthropics/commerce-agents) ·
[查看上游电商案例](https://github.com/anthropics/commerce-agents/tree/main/examples/retail) ·
[查看来源与适配记录](./NOTICE)

### 导购助手：把一次对话变成一次选购

从这样的需求开始：

> 周末带孩子去露营，帮我选一套装备，预算 1500 元。

导购助手通过工具查询商品，用商品卡和方案卡呈现推荐。顾客可以继续追问：

> 把推荐的两款帐篷对比一下，主要看空间和搭建难度。

对比结果直接呈现在界面里。选定商品后，再说一句“把这款加入购物车”，Agent 就调用商城后端，
页面里的购物车随之更新。退换货问题有订单和政策可查，顾客主动提供的偏好也可以通过记忆工具保存和召回。

这个案例把**需求理解、业务查询、结构化展示和业务操作**连成了一个交互过程。
商品卡、对比表和购物车共用商城的数据，用户可以边聊边选。

[查看 Agent 定义](./agenthub/agents/cma-shopping/agent.yaml) ·
[查看提示词](./agenthub/agents/cma-shopping/CLAUDE.md) ·
[查看完整实现说明](./agenthub/agents/cma-shopping/README.md)

### 商家助手：从发现问题到审批执行

商家可以从“今天有哪些经营问题需要关注？”开始，让 Agent 查询经营概况、库存告警和订单问题，
再围绕具体商品追问、分析或提出改动。

涉及调价、补货或商品信息调整时，交互继续向前走：

| 环节 | 用户看到的效果 |
| --- | --- |
| 了解情况 | 经营摘要和指标卡呈现查询结果 |
| 提出改动 | Agent 生成变更预览，说明准备修改什么 |
| 人工审批 | 运营人员在审批页检查并批准或驳回 |
| 执行改动 | Agent 的工具检查批准状态后，才应用对应改动 |

这条链路展示了如何把 Agent 放进有审批要求的业务流程：**分析和拟稿交给 Agent，关键写操作保留人工决定。**
本案例的变更门禁由商家 MCP 和业务后端实现，AgentHub 承载 Agent 的运行和工具调用。

[查看 Agent 定义](./agenthub/agents/cma-merchant/agent.yaml) ·
[查看提示词](./agenthub/agents/cma-merchant/CLAUDE.md) ·
[查看完整实现说明](./agenthub/agents/cma-merchant/README.md)

案例使用演示业务数据，结算未接入支付。

## 在线教育：从咨询到课堂

同一套课程业务，可以由多个各司其职的 Agent 服务家长、学生和老师。
这个案例包含五个角色，共用课程 MCP，分别定义自己的提示词、工具使用方式和交互界面。

| 角色 | 可以从什么问题开始 | 展示的效果 | Agent 定义 |
| --- | --- | --- | --- |
| 课程顾问 | “孩子上一年级，数学有点跟不上，有什么课？” | 查询课程和试听排期，在对话中展示课程方案与排期卡 | [edu-course-sales](./agenthub/agents/edu-course-sales/agent.yaml) |
| 数学老师 | “9 + 4 为什么等于 13？” | 用课件、教具和练习逐步讲解，根据孩子的作答继续教学 | [edu-math-tutor](./agenthub/agents/edu-math-tutor/agent.yaml) |
| 语文老师 | “b 和 p 怎么分？” | 用拼音、识字课件互动教学，演示数学与语文之间的会话预热和切换 | [edu-chinese-tutor](./agenthub/agents/edu-chinese-tutor/agent.yaml) |
| 作业辅导 | “8 + 7 我算成 14 了，哪里错了？” | 展示批改卡，按由浅到深的方式给提示 | [edu-homework-qa](./agenthub/agents/edu-homework-qa/agent.yaml) |
| 学情分析 | “这周班级整体怎么样？哪个知识点最需要补？” | 通过工具计算样例学习数据，展示周报并解读值得关注的信号 | [edu-learning-analytics](./agenthub/agents/edu-learning-analytics/agent.yaml) |

### 让 Agent 驱动一堂课

数学课演示了生成式 UI 的一条完整交互链：

1. Agent 读取教学大纲，用 `present_slide` 返回课件内容，界面渲染十格阵、数字分解等教具。
2. Agent 用 `present_exercise` 出一道练习，等待孩子点击作答。
3. 作答结果回到下一轮对话。Agent 根据答案选择继续、换一种教具重讲，或退回更基础的知识点。

**课件内容由 Agent 组织，组件由应用渲染，学生的操作又成为 Agent 的下一轮输入。**
同一套工具输出可以对应课堂屏幕，也可以由其他客户端实现自己的展示方式。

数学课会话就绪后，应用还会为同一访客提前创建语文课会话。切课时优先复用预建会话，减少等待；
预建会话失效时则回到正常创建流程。

[查看数学老师的教学方式](./agenthub/agents/edu-math-tutor/CLAUDE.md) ·
[查看课件与练习工具](./apps/storefront-web/lib/course/mcp-tools.ts) ·
[查看课堂界面](./apps/storefront-web/components/mobile/ClassroomApp.tsx)

### 让业务口径和数据有出处

课程顾问把开课安排、购课和退款规则放在随 Agent 版本发布的记忆文档中。
运营调整口径时，可以审阅文档改动，再随新版本发布。

学情分析通过 `get_weekly_report` 计算样例数据，再由 Agent 解释班级疑难点和需要关注的学生情况，
用 `present_report` 返回周报卡片。统计计算和语言解读各自承担明确的工作。

课程咨询、作业辅导和学情分析采用网页中的微信风格对话界面；
课程、学生和学习记录均用于演示。

[查看课程顾问的记忆文档](./agenthub/agents/edu-course-sales/memory/) ·
[查看课程 MCP 实现](./apps/storefront-web/lib/course/mcp-tools.ts)

## 如何在 AgentHub 上构建

这些案例使用同一种构建方式：**在仓库中定义 Agent，把业务能力接成 MCP，由 AgentHub 管理发布与运行，应用通过 SDK 接入会话。**

交付效率的提升，来自把每个 Agent 都要面对的工程工作沉淀到平台：复用运行环境和模型接入，
通过统一流水线发布版本，通过统一 SDK 管理会话。团队集中定义业务行为、接入业务系统和打磨交互，
再把同一套交付方式用到下一个 Agent。这是 AgentHub 追求 **10 倍交付效率**的路径。

### 1. 定义 Agent 的角色与能力

一个文件定义 Agent 对应仓库中的一个目录。以课程顾问为例：

```text
agenthub/agents/edu-course-sales/
├── agent.yaml       模型、运行环境、MCP 引用和工具权限
├── CLAUDE.md        角色、工作方式和回答边界
├── memory/          随版本发布的课程与运营口径
└── runtime/         随 Agent 包发布的代码
```

角色之间可以复用业务工具，同时保留各自的行为定义。例如数学老师和课程顾问共用课程 MCP，
但一个负责互动教学，一个负责选课咨询。

### 2. 接入业务工具

把商品查询、购物车、课程目录、学习数据等能力封装成 MCP 工具，注册到 AgentHub 后，在 Agent 定义中引用。

电商案例使用随 Agent 包发布的 **stdio MCP**，调用商城业务后端；
教育案例使用站点提供的**远程 MCP**，供五个 Agent 共用。
业务方决定工具能查什么、能改什么，以及什么操作需要审批。

### 3. 发布与运行

仓库绑定 AgentHub 项目后，默认分支上的提交进入平台流水线，冻结成 Agent 版本并按发布流程进入对应槽位。
模型选择、提示词、工具引用和随包代码因此可以一起审阅、一起发布。

AgentHub 提供隔离的会话沙箱、运行环境和模型接入。平台预热池可以减少会话启动等待，
应用也可以像切课案例一样，提前创建后续需要的会话。

### 4. 接入应用界面

应用服务端通过 AgentHub SDK 创建会话、发送用户输入、等待轮次完成，并把流式事件转发给前端。

`present_products`、`present_slide` 等工具返回结构化内容，前端将其渲染成商品卡、课件和报表；
点击选项、提交答案等操作再进入下一轮对话。平台凭据保留在应用服务端。

[查看会话接入代码](./apps/storefront-web/app/api/agenthub/) ·
[查看展示组件](./apps/storefront-web/components/generative/)

## 从案例到你的 Agent

可以从一个具体业务动作开始：帮助顾客选商品、给运营生成待审方案，或根据学生作答推进一节课。
为它定义角色和工具，在 AgentHub 上发布，再把会话接入你的应用。

这个仓库中的两个案例提供了不同起点：

- **面向交易和运营的业务**：从电商案例看查询、推荐、状态联动和审批如何配合。
- **面向知识服务的业务**：从教育案例看多角色分工、版本化业务口径和交互式教学如何组织。

**[进入 AgentHub，构建你的 Agent →](https://agenthub.zhenguanyu.com/921b91f0-e49a-4733-ab7c-c7fd66f01941/sessions)**

后续案例会继续沿用“业务场景、交互效果、Agent 定义与工具实现”的组织方式。
可以关注本仓库的更新，也可以直接从 [Agent 定义目录](./agenthub/agents/) 深入查看感兴趣的角色。

## 源码与致谢

[Agent 定义](./agenthub/agents/) · [演示应用](./apps/storefront-web/) ·
[工程约定](./AGENTS.md) · [文件定义 Agent 说明](./agenthub/AGENTS.md)

感谢 Anthropic 开源 [commerce-agents](https://github.com/anthropics/commerce-agents)。
本项目采用 [Apache License 2.0](./LICENSE)，上游代码来源和适配记录见 [NOTICE](./NOTICE)。
