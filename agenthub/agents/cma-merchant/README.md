# cma-merchant

一个 AgentHub **文件定义 Agent**，复刻 [anthropics/commerce-agents](https://github.com/anthropics/commerce-agents)
（下称 CMA）的商家 Agent：CMA 自己的工具注册表、门禁、护栏、展示层增强原样跑（改了什么见
仓库根目录的 [NOTICE](../../../NOTICE)），经一个 stdio MCP server
（`runtime/src/merchant-stdio-server/`）暴露给沙箱里的 Claude Code CLI。

这个包里除了那个 stdio server 和 `.claude/agents/analyst.md`，其余都是 vendor 来的。
兄弟包：[`../cma-shopping/`](../cma-shopping/README.md)。

**这个 Agent 的特点是写操作要人批。** 它不直接改商品和价格：每个写工具（`stage_*`）只把
改动**暂存**成一条待审记录，镜像到站点的 `/operator` 页面；人在那里批准之后，`apply_change`
才会真的执行。这是 CMA 自己的 `require_host_approval` 机制，跨进程边界落地在这个包里。

## 目录

```
agent.yaml                    # 模型、Environment、mcpServers（含 tools[] 声明）、
                              #   agentOptions、env
CLAUDE.md                     # 系统提示词，由 CMA 的 managed-agent prompt 推导而来，
                              #   见 runtime/scripts/derive-claude-md.py
scripts/setup.sh              # 本地开发用：pip install --user --no-deps 下面四个包
skills.json                   # 空的——下面 5 个 skill 是 vendor 进来的，不走安装
.claude/skills/<5 个>/        # 从 CMA vendor：performance-insights、catalog-listings、
                              #   inventory-operations、pricing-promotions、
                              #   marketing-campaigns
.claude/agents/analyst.md     # 只读工具白名单的子 agent，用于多步经营分析
runtime/
  src/commerce-common/        # vendor，逐字节一致（第二份拷贝，见 vendor-cma.sh）
  src/shopping-agent-core/    # vendor，逐字节一致（第二份拷贝——MockRetailMerchant
                              #   内部包着一个 MockRetail 实例）
  src/merchant-agent-core/    # vendor，逐字节一致
  src/merchant-stdio-server/  # 本仓库新写：stdio MCP server + 审批同步机制
  scripts/derive-claude-md.py # 可重跑的 CLAUDE.md 推导 + 差异检查
  scripts/_vendor-reference/  # CMA system.md 的提交副本，上面那个脚本的输入
  tests/smoke_stdio.py        # 离线 MCP client 冒烟测试
```

## 审批回路是怎么闭合的

写操作跨了两个进程：Agent 在沙箱里，审批页在站点上。

1. `stage_*` 工具把改动写进 `ChangeLedger`，状态是待审。
2. `_mirror_changes` 把待审集合推到站点的 `/api/changes/mirror`，`/operator` 页面因此
   有东西可批。这一步是 **best-effort**：推失败不影响暂存，Agent 照样回报「已暂存」。
3. 人在 `/operator` 上点批准。
4. `apply_change` 执行前，`_fetch_approved_ids` **重新拉一遍**已批准集合（从不缓存），
   只有在这一刻确实被批准的 id 才会落地。

`MerchantSessionState` 和 `ChangeLedger` 都要持久化到磁盘；后者上游没有自带序列化，本仓库
在 server 层写了一个小的 JSON 编解码。

两个交付时踩到并修掉的真问题记在这里，改这块代码前值得看一眼：

- 展示层信封（`CMA_UI_DELIVERY`）的逻辑如果不严格限定在真正的 present_* 工具名上，会把
  `stage_price_update` 自己的返回值静默覆盖掉。
- 审批镜像的存储要按 `ChangeLedger` 的生命周期隔离，否则两次不同生命周期生成的同一个递增
  `change_id` 会撞车。

## 本地验证

Python 环境与 `cma-shopping` 相同（3.12，三方依赖版本见根 README 的「平台侧要先准备什么」），
外加这个包自己的四个本地包：

```bash
pip install --no-deps \
  runtime/src/commerce-common runtime/src/shopping-agent-core \
  runtime/src/merchant-agent-core runtime/src/merchant-stdio-server

# 只验机制，不连站点
python runtime/tests/smoke_stdio.py

# 连上本地站点，跑完整的 暂存 → 批准 → 执行 跨进程回路
STOREFRONT_WEB_URL=http://localhost:8000 python runtime/tests/smoke_stdio.py
```

`runtime/tests/smoke_stdio.py` 的 `EXPECTED_TOOLS` 是这个 MCP 22 个工具名的真相源，
`agent.yaml` 里 `mcpServers[].tools[]` 的清单要与它一致。
