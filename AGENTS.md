# AGENTS.md — agenthub-showcase

这个仓库的工程约定。产品层面的介绍在 [README.md](./README.md)，这里只写「改这个仓库要知道的事」。

## 这是两件独立的东西共用一个仓库

| | `agenthub/agents/*` | `apps/storefront-web` |
| --- | --- | --- |
| 是什么 | 七个**文件定义 Agent** | 一个 Next.js 站点 |
| 怎么发布 | 推默认分支 → 平台提交流水线冻结成版本 → 发到槽位 | 普通的前端构建部署 |
| 产物 | Agent 版本（含随包代码） | 一个 HTTP 服务 |

两条发布路径互不相干，改一边不会触发另一边。文件定义 Agent 的写法见
[`agenthub/AGENTS.md`](./agenthub/AGENTS.md)。

站点一份代码扮演三个角色：演示前端、Agent 反向调用的业务后端、教育侧的远程 MCP
（`/api/mcp/course`）。

## 目录

```
agenthub/
  AGENTS.md                     文件定义 Agent 的约定
  agents/cma-shopping/          导购 Agent 包（agent.yaml、CLAUDE.md、runtime/…）
  agents/cma-merchant/          商家 Agent 包，带写操作人工审批
  agents/edu-*/                 教育侧五个 Agent，共用一个课程 MCP
apps/storefront-web/            Next.js 站点（前端 + 业务后端 + 远程 MCP）
shared/course-stdio-server/     课程 MCP 的事实源（Python 实现）
Dockerfile                      容器镜像
start-storefront-web.sh         生产启动脚本
scripts/
  vendor-cma.sh                 从上游 commerce-agents 重新 vendor
  localize-fixtures.py          vendor 之后把固定数据本地化（人民币等）
  sync-edu-runtime.sh           把 shared/course-stdio-server 同步进各教育 Agent 包
  course-mcp-parity/            站点侧远程 MCP 与 Python 实现的对拍
  lib/claude_md_derivation.py   两个电商 Agent 的 derive-claude-md.py 共用的辅助函数
  ensure-workspace-symlinks.sh  启动时幂等重建 workspace 符号链接（今天是空操作）
  logger.sh                     shell 日志工具库
docs/showcase-site.md           演示站的结构与扩展方式
```

## 三条会被踩到的规则

**1. Vendor 来的代码不要手改。**

CMA 的源码在每个 Agent 包各自的 `runtime/src/` 下（每个包要能独立发布，所以
`commerce-common` 和 `shopping-agent-core` 在 `cma-merchant/` 下有第二份拷贝——
`MockRetailMerchant` 包着一个 `MockRetail` 实例）。这些拷贝由 `scripts/vendor-cma.sh`
从上游的本地 clone 整个覆盖过来，手改活不过下一次 vendor。

需要改上游行为时的正确做法：改 `vendor-cma.sh` 的拷贝清单，或者在
`localize-fixtures.py` 里加一条幂等的后处理。哪些文件与上游逐字节一致、哪些做过适配，
[NOTICE](./NOTICE) 里逐条列着，改动 vendor 范围时要同步更新它。

**2. 教育 MCP 的事实源是 `shared/course-stdio-server`。**

各教育 Agent 包下的 `runtime/src/course-stdio-server` 是由
`scripts/sync-edu-runtime.sh` 生成的副本（要打进 Agent 包，所以必须进 git）。
改逻辑改事实源，然后跑同步脚本。站点侧的 `/api/mcp/course` 是同一套逻辑的 TypeScript
实现，两者由 `scripts/course-mcp-parity/run.sh` 对拍锁住——改了一边就要跑一次对拍。

**3. 零改写原则（有三个例外，都记在 NOTICE 里）。**

两个电商 Agent 的工具契约、门禁、护栏、fencing、展示层增强，用的都是 CMA 自己的代码。
本仓库新写的只有：两个 stdio MCP server（`runtime/src/{storefront,merchant}-stdio-server/`，
把 CMA 的 executor 暴露给沙箱里的 Claude Code CLI）、教育侧的课程 MCP，以及
`apps/storefront-web`。

这条原则是这个演示的立论本身：换掉的只是宿主，不是行为。所以每一次偏离都必须写进
[NOTICE](./NOTICE) 第 3 节（Apache-2.0 §4(b) 也要求标注改动过的文件）。目前有三处：

- `cma-shopping` 的 `presentation.py` / `turn.py` / `registry.py`：让建议 chips 随组件
  一起返回，省掉每轮一次模型往返。`cma-merchant` 的同名包**没有**这个改动。
- 两个 stdio server 包内 `_examples/` 下的两个 `__init__.py`：替换成空 stub，否则会连带
  拉进本仓库不 vendor 的上游子树。
- 所有 `retail/data/*.json`：由 `localize-fixtures.py` 换成人民币等本地化内容。

改了 vendor 范围或新增偏离，NOTICE 要同步更新。

## 各处文档

| 问题 | 去哪看 |
| --- | --- |
| 一个 Agent 包逐字段是什么意思 | `agenthub/agents/cma-shopping/README.md`、`agenthub/agents/cma-merchant/README.md` |
| CLAUDE.md 是怎么从 CMA 的提示词推导出来的 | 两个电商 Agent 包各自的 `runtime/scripts/derive-claude-md.py`（可重跑） |
| 站点是怎么组织的、怎么加一个演示视角 | [`docs/showcase-site.md`](./docs/showcase-site.md) |
| 平台侧要人工做哪些一次性配置 | [README.md](./README.md) 的「平台侧要先准备什么」 |
| 哪些文件来自上游、改过什么 | [NOTICE](./NOTICE) |
