# agenthub-showcase

用 AgentHub 的**文件定义 Agent**（file-defined agent）搭出来的一组真实可用的 Agent 应用，
外加一个把它们跑起来的站点。它回答的是同一个问题：**把一个非玩具的 Agent 放到 AgentHub 上，代码长什么样、平台替你做了什么。**

> AgentHub 是我们内部的 Agent 运行平台，控制台与文档站没有公开地址。这个仓库开源的是
> **Agent 定义、MCP 实现和演示站点的完整代码**——即使你用的是别的平台，这套「Agent 定义
> 进 git、业务能力包成 MCP、展示层返回数据而不是 HTML」的组织方式也是可以照抄的。

页面上写的每一句都可以在这个仓库里核到出处——这是这个项目唯一的说服力来源，所以「声称」与「实测」对不上，是这里最贵的 bug。

## 两条业务线，七个视角

**电商**：复刻 [anthropics/commerce-agents](https://github.com/anthropics/commerce-agents)（CMA）的导购与商家两个 Agent。
CMA 自己的工具契约、门禁、护栏、展示层原样搬过来（`scripts/vendor-cma.sh` 可重复执行的 vendor，改了什么在 [NOTICE](./NOTICE) 里逐条列着），
换掉的只是宿主：不再是 CMA 的 FastAPI + Agent SDK，而是 `agent.yaml` + 沙箱里的 stdio MCP server。

**在线教育**：课程顾问、数学课、语文课、作业批改、学情分析五个 Agent，共用一个课程 MCP。

| 视角 | 角色 | 一句话 | Agent |
| --- | --- | --- | --- |
| 导购助手 | 消费者 | 会聊天的商城：说需求，它给方案 | `cma-shopping` |
| 商家助手 | 商家运营 | 看得懂经营数据，还能替你把改动拟好 | `cma-merchant` |
| 课程顾问 | 家长 | 在微信里就把课选完了 | `edu-course-sales` |
| 数学课 | 一年级学生 | Agent 不是在回答，是在上课 | `edu-math-tutor` |
| 语文课 | 一年级学生 | 同一学生切课，不冷启 | `edu-chinese-tutor` |
| 作业批改 | 学生 / 家长 | 不直接给答案，一层一层给提示 | `edu-homework-qa` |
| 学情分析 | 老师 / 教研 | 数字只能来自管线，解读才归模型 | `edu-learning-analytics` |

## 架构

```
仓库（本 repo）
├── agenthub/agents/<name>/        ← Agent 的全部定义：agent.yaml（模型/工具/MCP/env）
│                                     + CLAUDE.md（系统提示词）+ runtime/（随包发布的代码）
│                                     推 main → 平台流水线冻结成版本 → 发到 test / production
└── apps/storefront-web/           ← Next.js 站点，一份代码扮演三个角色
                                      · 演示前端：渲染 Agent 返回的展示卡片
                                      · 业务后端：商品/购物车/订单/记忆/审批 HTTP 接口
                                      · 课程 MCP：/api/mcp/course（Streamable HTTP）

运行时
浏览器 ──HTTP──> 站点路由 ──SDK──> AgentHub 控制面 ──> 会话沙箱（隔离容器）
                                                        └── Claude Code CLI
                                                             ├── stdio MCP（电商，随包发布）
                                                             └── 远程 MCP（教育，站点提供）
                                                                  └──HTTP──> 站点业务后端
```

三件事值得单独说：

- **平台 token 只在服务端**。浏览器永远不直接连控制面，全部经站点自己的 `app/api/agenthub/*` 路由（SDK `@kanyun-ai-infra/agenthub`）。
- **Agent 反向调用业务后端**。沙箱里的工具打的是这个站点的真实接口，所以它读写的是页面上那个购物车，不是它脑补的一份数据。
- **展示层是数据不是 HTML**。`present_*` 工具返回结构化 payload，前端按组件名渲染。同一个 Agent 换个端就是另一套皮。

## 用到了平台的哪些能力

| 能力 | 在这个项目里的体现 |
| --- | --- |
| 文件定义 Agent | 模型、工具、提示词全在 git 里，改动经流水线冻结成版本，不是控制台点出来的配置 |
| 独立沙箱运行时 | 每个会话一个隔离容器，依赖由平台 Environment 预装，Agent 在里面起真实进程 |
| 托管 MCP 工具 | 电商侧随包发布的 stdio MCP；教育侧注册成远程 MCP，按 id 在 `agent.yaml` 引用 |
| 生成式 UI | `present_products` / `present_slide` / `present_metrics` 等返回结构化数据，前端渲染成卡片、课件、报表 |
| 会话与 Turn API | 一行 SDK 建会话、发一轮、等终态；历史可回放，turn 可中止 |
| 流式输出 | SSE 逐字回显，同时用 `waitForTurn` 判终态——渲染与控制分开 |
| 预热池 | 会话从暖好的槽位领用，建会话从秒级降到毫秒级（见下） |
| 终端用户身份（EUID） | 池在暖机时铸好身份，沙箱里以 `PILOT_END_USER_ID` 可读；购物车与记忆跟着这个身份走 |
| 反向调用业务后端 | Agent 回调站点 HTTP 接口，读写真实数据 |
| 写操作人工审批 | 商家侧的写操作先落成待审改动，人在 `/operator` 批准后才执行 |
| 会话回收与恢复 | 闲置沙箱被回收省成本，用户再开口时自动拉起、上下文不丢 |
| 记忆 | 尺码、预算、忌口这类长期事实写进记忆，下次对话直接召回 |
| 统一模型接入 | 换模型是改 `agent.yaml` 一行；模型网关统一鉴权、限流、计费 |

**预热与跨 Agent 切换**（教育侧的一个专门演示）：学生进数学课时，站点为**同一个访客身份**预先建好语文课的会话；
切课那一刻直接复用已就绪的会话。实测建会话 5.1s（冷启）→ 0.8s（池命中），切课点击到就绪约 1s。
页面右栏的事件面板会如实标出「预热命中」还是「预热未命中」。

## 目录

```
agenthub/agents/<name>/
  agent.yaml            模型、MCP 引用、allowedTools/disallowedTools、env
  CLAUDE.md             系统提示词（电商侧由 runtime/scripts/derive-claude-md.py 从 CMA 提示词推导，可重跑）
  runtime/src/          随包发布的代码：stdio MCP server + vendored CMA
apps/storefront-web/
  app/api/agenthub/     建会话、查状态、预热——平台 token 只在这里
  app/api/backend/      Agent 反向调用的业务接口（商品/购物车/订单/履约/审批）
  app/api/mcp/course/   教育侧远程 MCP（Streamable HTTP）
  lib/showcase/         演示视角与能力目录（cases.ts / capabilities.ts）
  components/mobile/    七个视角的「手机」：商城、微信、课堂、商家面板
scripts/vendor-cma.sh   从上游 commerce-agents 重新 vendor（保留本仓适配过的文件）
start-storefront-web.sh 生产启动脚本（有 pm2-runtime 就用，没有就直接 next start）
Dockerfile              容器镜像
docs/showcase-site.md   演示站的结构、扩展方式、踩过的坑
```

## 平台侧要先准备什么

这些是控制台上一次性的人工操作，git 里的提交做不到，所以列在这里：

1. **建一个项目**，并把这个仓库绑上去（推 main 触发发布流水线）。
2. **建一个 Environment**（本仓叫 `cma-python`），把 CMA 的三方依赖固定版本烤进镜像：
   `pydantic==2.13.4` / `anthropic==0.122.0` / `mcp==1.29.0` / `pyyaml==6.0.3` / `httpx==0.28.1`
   （版本取自上游 commerce-agents `requirements.txt`，commit 见 [NOTICE](./NOTICE)）。
   这是个对话型负载，`defaultTtlSeconds` 给长一点。
3. **注册三个 managed MCP**，把拿到的 id 填回各 `agent.yaml` 的 `mcpServers`（仓库里是
   `vcrd_PLACEHOLDER` 占位）：
   - `storefront`、`merchant`：`kind=stdio`，`command=python3`，
     `args=["-m", "storefront_stdio_server"]` / `["-m", "merchant_stdio_server"]`
   - `course`：`kind=remote`，指向本站的 `/api/mcp/course`（Streamable HTTP）。
     教育侧用 remote 而不是 stdio，是因为 `always_ask` 这类工具级人工审批只在经网关的
     remote MCP 上有强制点。
   ⚠️ MCP 的结构（command/args）创建后不可改，只能归档重建，所以别在 `args` 里编版本号。
4. **把各 `agent.yaml` 的 `BACKEND_BASE_URL`** 指向你自己部署的 storefront-web，`/api` 后缀
   不能少。

## 本地跑起来

需要 Node ≥ 22.19、pnpm 10。站点连的是真实控制面，不是 mock：

```bash
pnpm install
cd apps/storefront-web
AGENTHUB_TOKEN=<控制台签发的 API token> \
AGENTHUB_CONTROL_PLANE_URL=<你的控制面地址> \
AGENTHUB_STAGE=production \
AGENTHUB_PROJECT_ID=<项目 uuid> \
AGENTHUB_AGENT_ID=<cma-shopping 的 workload uuid> \
AGENTHUB_MERCHANT_AGENT_ID=<cma-merchant 的 workload uuid> \
AGENTHUB_COURSE_SALES_AGENT_ID=<edu-course-sales 的 workload uuid> \
AGENTHUB_MATH_TUTOR_AGENT_ID=<edu-math-tutor 的 workload uuid> \
AGENTHUB_CHINESE_TUTOR_AGENT_ID=<edu-chinese-tutor 的 workload uuid> \
AGENTHUB_HOMEWORK_QA_AGENT_ID=<edu-homework-qa 的 workload uuid> \
AGENTHUB_LEARNING_ANALYTICS_AGENT_ID=<edu-learning-analytics 的 workload uuid> \
pnpm dev            # http://localhost:8000
```

七个视角各对应一个 `*_AGENT_ID`（映射见 `lib/agenthub/client.ts`），填的是 **workload id**（控制台 Agent 页可复制）不是 slug；
只想看其中一两个视角就只配那几个，没配的会显示「未接入」，不会静默降级成别的 Agent。
token 在控制台「API Tokens」签发，只放服务端环境变量，别进浏览器、别进仓库。

**本地能跑到哪一步**：`CMA_UI_DELIVERY=result_text` 下展示卡片就在工具返回值里，本地完全正常。
而商家审批回环是**沙箱打回站点**的调用，需要一个沙箱能访问到的部署；本地跑时 `/operator` 是空的、`apply_change` 找不到已批准的改动——
这是审批门禁在正确工作，不是故障。

## 生产模式跑 / 部署

```bash
pnpm install
pnpm turbo build
./start-storefront-web.sh          # 默认 8080，用 PORT 覆盖
```

或者用容器（`Dockerfile` 在仓库根目录，已实测可跑）：

```bash
docker build -t agenthub-showcase .
docker run --rm -p 8080:8080 \
  -e AGENTHUB_TOKEN=... -e AGENTHUB_CONTROL_PLANE_URL=... \
  -e AGENTHUB_PROJECT_ID=... -e AGENTHUB_AGENT_ID=... \
  agenthub-showcase
```

**一个 `AGENTHUB_*` 都不配也能起来**：页面、商品、课件、审批页都能看，只是每个视角
显示「未接入」——因为那部分需要真实的 Agent 会话。

两件部署时要注意的：

- **端口要与部署平台登记的 httpPort 一致**。健康检查和 ingress 打的是那个端口，
  对不上就是「部署起来了但外面打不进」。
- **可变状态默认落在容器可写层**（购物车、记忆、待审改动，见
  `apps/storefront-web/lib/backend/paths.ts`）。要跨重启保留就设 `STOREFRONT_DATA_DIR`
  指到挂载卷上；容器镜像里已经把默认目录声明成 `VOLUME`。

| 环境变量 | 作用 |
| --- | --- |
| `AGENTHUB_TOKEN` | 控制台签发的 API token。**只放服务端**，别进浏览器、别进仓库 |
| `AGENTHUB_CONTROL_PLANE_URL` | 控制面地址 |
| `AGENTHUB_PROJECT_ID` / `AGENTHUB_STAGE` | 项目 uuid、槽位（`test` / `production`） |
| `AGENTHUB_*_AGENT_ID` | 七个视角各一个 workload id，映射见 `lib/agenthub/client.ts` |
| `NEXT_PUBLIC_AGENTHUB_PORTAL` | 控制台域名；不设时页面上的文档入口回落到本仓库 |
| `PORT` | 监听端口，默认 8080 |
| `STOREFRONT_DATA_DIR` | 可变状态目录，默认 `apps/storefront-web/.data` |

## 从这里开始

| 去哪 | 看什么 |
| --- | --- |
| [AGENTS.md](./AGENTS.md) | 这个仓库的工程约定：vendor 策略、两类产物的发布路径 |
| [agenthub/AGENTS.md](./agenthub/AGENTS.md) | 文件定义 Agent 的写法与本地校验 |
| [docs/showcase-site.md](./docs/showcase-site.md) | 站点怎么组织的，以及做的时候踩到并修掉的实锤问题 |
| [NOTICE](./NOTICE) | 哪些文件来自上游 commerce-agents、改过什么 |

想加一个演示视角：在 `lib/showcase/cases.ts` 加一条记录，配一个手机端组件，就出现在页面上。

## License

Apache License 2.0——见 [LICENSE](./LICENSE)；哪些文件来自上游 commerce-agents、哪些是本仓原创，见 [NOTICE](./NOTICE)。
