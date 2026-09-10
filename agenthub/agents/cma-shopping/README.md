# cma-shopping

一个 AgentHub **文件定义 Agent**，复刻 [anthropics/commerce-agents](https://github.com/anthropics/commerce-agents)
（下称 CMA）的导购 Agent：CMA 自己的工具注册表、门禁、fencing、展示层增强原样跑
（改了什么见仓库根目录的 [NOTICE](../../../NOTICE)），经一个 stdio MCP server
（`runtime/src/storefront-stdio-server/`，约 250 行）暴露给沙箱里的 Claude Code CLI。
这个 server 是本包里唯一的新代码。

兄弟包：[`../cma-merchant/`](../cma-merchant/README.md)。

## 目录

```
agent.yaml                      # 模型、Environment、mcpServers、agentOptions、env
CLAUDE.md                       # 系统提示词，由 CMA 的 managed-agent prompt 推导而来
scripts/setup.sh                # 本地开发用：pip install --user --no-deps 下面三个包
skills.json                     # 空的——下面 5 个 skill 是 vendor 进来的，不走安装
.claude/skills/<5 个>/          # 从 CMA vendor，做了轻量改动（去掉 web_search 引用、
                                #   补工具名标注），每个 SKILL.md 文件头有说明
runtime/
  src/commerce-common/          # vendor，逐字节一致
  src/shopping-agent-core/      # vendor，逐字节一致
  src/storefront-stdio-server/  # 本仓库新写：stdio MCP server
  scripts/derive-claude-md.md   # CLAUDE.md 是怎么一步步推导出来的
  tests/smoke_stdio.py          # 离线 MCP client 冒烟测试
evals/smoke.yaml                # 验收标准写成 eval 用例
```

## 两种后端形态

同一份 Agent 代码有两种跑法，由 `agent.yaml` 的 `BACKEND_BASE_URL` 决定：

- **不设**：跑内嵌的 `MockRetail` + `JsonFileMemoryStore`，全部状态关在沙箱里。适合本地开发
  和离线测试。
- **设了**：`http_backend.py` / `http_memory.py` 打到 `apps/storefront-web` 的真实接口，
  Agent 读写的就是页面上那一个购物车、订单和偏好。演示站用的是这一种。

展示层同理：`CMA_UI_DELIVERY=result_text`（模式 A）把展示卡片放在工具返回值里，
`backend_post`（模式 B）由沙箱反向 POST 回站点。两种都实现了，演示站用模式 A。

⚠️ 模式 B 在没有后端时会**静默丢掉每一张卡片**（`__main__.py` 的 `_post_ui_event` 只 log
一次就返回，不回落到模式 A），所以别在没绑后端时选它。

## 本地验证

CMA 的源码用了 3.11+ 语法（`StrEnum` 之类），每个 vendored `pyproject.toml` 都写着
`requires-python = ">=3.11"`。三方依赖版本取自上游自己的 `requirements.txt`，三个本地包
`--no-deps` 装——和 `scripts/setup.sh` 做的事一样：

```bash
python3.12 -m venv .venv
pip install pydantic==2.13.4 anthropic==0.122.0 mcp==1.29.0 pyyaml==6.0.3 httpx==0.28.1
pip install --no-deps \
  runtime/src/commerce-common runtime/src/shopping-agent-core runtime/src/storefront-stdio-server
```

### 冒烟测试

`runtime/tests/smoke_stdio.py` 起真实的 MCP client 走 stdio，跨三个独立子进程：

```
$ python runtime/tests/smoke_stdio.py
[1] tools/list: exactly the 20 expected names
[1] get_preferences uses the inline-context description; 'status' dropped everywhere (MCP path)
[2] search_products('tent') -> AR-1201 present
[2] add_to_cart(AR-1201) -> 'Added AR-1201 x1. Cart now has 1 item(s), subtotal 149.00 USD.'
[4] present_products -> result_text envelope: dict_keys(['displayed', 'component', 'payload'])
[4] present_products with an unseen id -> refused, unwrapped
[5] new process, recall_memories -> finds turn-1's saved fact
[3] new process, add_to_cart on a never-seen id -> held
[control] fresh state dir, same product_id -> held (as expected)

ALL CHECKS PASSED
```

除了工具名清单，它还锁住两条容易漂的保真点：`get_preferences` 发布的描述必须是
`INLINE_CONTEXT_DESCRIPTIONS` 那个变体，以及 `published_schema()` 对**每个**工具都丢掉
`status` 字段（不只是展示类工具）——早期版本的测试断言反了，写完立刻被抓到。

**已知且有意的限制**：`MockRetail` 的购物车活在内存里的 `SessionCarts`（上游自己的代码，
未改动），不落盘，所以进程重启后购物车不保留。上面 `[5]` 那条持久化断言验的是「来源约束」
（对之前见过的 id 能加购）和「记忆」，不是购物车本身。购物车的真相属于后端，接上真实后端
之后由后端自己持久化。详见 `storefront_stdio_server/__main__.py` 的 `_build_backend`
docstring。

### 用真实 CLI 复核工具面

拿 Claude Code CLI 自己跑一遍（指向一个本地假端点，只看 `init` 事件，不需要模型真的回答）：

```bash
claude -p "hi" --output-format stream-json --verbose --mcp-config .mcp.json
```

`system`/`init` 事件里带 `"mcp_servers": [{"name": "storefront", "status": "connected"}]`
和正好 20 个 `mcp__storefront__*`，与 `smoke_stdio.py` 验的是同一组名字——这是用**生产上真正
会用的那个客户端**做的第二次独立确认，而不只是参考实现的 Python MCP client。

## 关于 `allowedTools` 与 `disallowedTools`

`agent.yaml` 里两个字段都写了，作用不同，不要只写一个：

- `allowedTools` 是**配置期**的意图声明与正确性检查。它写的是裸名 `mcp__storefront`
  而不是 20 个 `mcp__storefront__<tool>`——裸名就是平台对一个已声明 MCP server 的基线粒度，
  逐个列既冗余又会随注册工具集漂移。
- `disallowedTools` 才是真正把内置工具从模型可见集合里摘掉的那个。写的是上游 CMA
  `tools=["Skill"]` 的补集。

上游用同一套 skills 和同一个 stdio server，只挂 `Skill` 就能跑，这是「这一族 Agent 不需要
任何内置工具」的阳性对照。
