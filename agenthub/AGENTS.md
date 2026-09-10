# AGENTS.md — agenthub/

这个目录放的是**文件定义 Agent**（file-defined agent）：一个 Agent 就是这个仓库里的一组
文件，往默认分支推代码就是发布动作——平台的提交流水线会把它冻结成一个版本，再发到
test / production 槽位。

## 目录布局

- `agents/<slug>/`：一个目录 = 一个 Agent（判据是它下面有 `agent.yaml`）。当前七个：

  | 目录 | 说明 |
  | --- | --- |
  | `agents/cma-shopping/` | 导购 Agent，复刻 commerce-agents 的 shopping |
  | `agents/cma-merchant/` | 商家 Agent，复刻 commerce-agents 的 merchant，带写操作人工审批 |
  | `agents/edu-course-sales/` | 课程顾问 |
  | `agents/edu-math-tutor/` | 数学课 |
  | `agents/edu-chinese-tutor/` | 语文课 |
  | `agents/edu-homework-qa/` | 作业批改 |
  | `agents/edu-learning-analytics/` | 学情分析 |

- `environments/`、`subagents/`：平台保留目录，本仓库没用。

## 约定

- **这个目录不走站点的构建流水线**。`apps/storefront-web` 是另一条线（普通 Next.js 服务）；
  这里的发布动作就是「推默认分支」，两者互不相干。
- **Agent 目录里的 `CLAUDE.md` 是那个 Agent 的系统提示词**，发布时随版本冻结。它和仓库根目录
  的 `CLAUDE.md` 没有任何关系。
- **密钥只能用 `secretRef` 引用**，不能写明文；`agenthub agent check` 会拦明文。
- **平台资源 id 是环境相关的**。`agent.yaml` 里的 `mcpServers` id 和 `BACKEND_BASE_URL`
  都是单值、按环境作用域，没有 per-stage 覆盖机制——一个仓库同时只能指一个环境。仓库里提交的
  是 `vcrd_PLACEHOLDER` 占位，换成你自己控制面上的 id。

## 本地校验

```bash
# 只校验文件本身（schema、引用完整性、明文密钥）
agenthub agent check

# 连上控制面校验引用的 Environment / MCP 真的存在
AGENTHUB_BASE_URL=<你的控制面地址> \
AGENTHUB_TOKEN=<API token> \
agenthub agent check --refs --require-remote --project-id <项目 uuid>
```

`agent check` 校验不了 MCP id 写没写对——id 错了要到流水线 freeze 那一步才报错。

`cma-merchant` 的 `agent.yaml` 用了 `mcpServers[].tools[]` 这个较新的声明形态，发布出去的
CLI 如果 schema 落后于平台契约，可能会把这个 key 报成无法识别。**这时不要靠删掉 `tools:`
来「修复」**，升级 CLI 即可。

## 相关文档

- 仓库整体约定与 vendor 策略：[`../AGENTS.md`](../AGENTS.md)
- 每个 Agent 包逐字段的说明：各 Agent 目录下的 `README.md`
