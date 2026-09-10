# 教育场景共用的 MCP

> 源头在仓库根的 `shared/`，不在 `agenthub/agents/` 下面——那个目录里的每一项平台都
> 当成一个 agent，没有 agent.yaml 就报 `PIPELINE_INVALID_AGENT_YAML`。
> 四个 agent 各自的副本由 `scripts/sync-edu-runtime.sh` 生成。

四个教育 agent（顾问 / 上课 / 批改 / 学情）共用这一个 stdio MCP server，而不是各带一个。
理由是它们看的是同一份业务数据——课程目录、课件、学生作答记录——拆成四份只会让口径漂移。

```
runtime/src/course-stdio-server/
└── course_stdio_server/
    ├── __main__.py     11 个工具
    └── data/           课件 / 课程目录 / 一周作答样本
```

## 工具

| 类别 | 工具 |
|---|---|
| 读数据 | `get_lesson` `get_course_catalog` `get_trial_slots` `get_weekly_report` `get_student_progress` |
| 展示 | `present_slide` `present_course_plan` `present_trial_slots` `present_correction` `present_report` `present_suggestions` |

展示工具走 D-R4 mode A：返回文本本身就是 UI 信封
`{"displayed": true, "component": ..., "payload": ...}`，前端 `parseUiEnvelope` 直接解析，
不需要沙箱反向打回浏览器。

## 两条要紧的约定

**课件由 agent 现编。** `present_slide` 传标题、正文、教具，`present_exercise` 传题目和
选项，App 只负责画。原来是固定 8 页、agent 只能选页码——它想讲的和页面写的对不上，
讲解就散，而且换个知识点整套课件得重写。固定课件文件降级成 `get_lesson` 返回的教学大纲，
agent 参考着推进，不照搬。

**`get_weekly_report` 是学情数据唯一的来源，真算不硬编码。** 它在沙箱里读 CSV 算正确率、
平均耗时、连续错题告警。实测与上游 `learning-analytics` 自己的 Python 管线产物逐项吻合
（25 题 / 4 人 / 0.6，三个知识点数值全对），这是这份实现的阳性对照。

`present_report` 会把键名从 camelCase 归一成 snake_case：`get_weekly_report` 沿用上游
`weekly-report.schema.json` 的 camelCase（那是给下游系统的契约，不该为前端改），而 UI 信封
统一 snake_case。不转换的话卡片上「答题量/活跃学生」会静默显示成「—」——字段不存在不报错，
只是空的。

## 本地验证

`mcp` 包不在仓库依赖里（它由平台 Environment `cma-python` 预装），本地验纯逻辑用打桩：

```python
import sys, types
fm = types.ModuleType("mcp.server.fastmcp")
class F:
    def __init__(s,*a,**k): pass
    def tool(s,*a,**k): return lambda fn: fn
    def run(s,*a,**k): pass
fm.FastMCP = F
sys.modules.update({"mcp": types.ModuleType("mcp"),
                    "mcp.server": types.ModuleType("mcp.server"),
                    "mcp.server.fastmcp": fm})
import course_stdio_server.__main__ as m   # 之后所有工具都是普通函数，可直接调
```

## 接到平台上要做的事

1. 在控制台注册这个 MCP（门户操作，SDK 没有这个接口），把拿到的 id 回填进五个
   `agent.yaml` 的 `mcpServers`——仓库里提交的是 `vcrd_PLACEHOLDER` 占位。
2. 推默认分支跑流水线发布。
3. 把五个 workload id 配成站点的环境变量：`AGENTHUB_COURSE_SALES_AGENT_ID` /
   `AGENTHUB_MATH_TUTOR_AGENT_ID` / `AGENTHUB_CHINESE_TUTOR_AGENT_ID` /
   `AGENTHUB_HOMEWORK_QA_AGENT_ID` / `AGENTHUB_LEARNING_ANALYTICS_AGENT_ID`。

没配的视角，页面会如实显示「未接入」，不会静默降级成别的 Agent。
