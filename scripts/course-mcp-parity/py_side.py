"""对拍的 Python 一侧：调用 stdio server 的真实实现，打印各工具输出。

不需要装 mcp SDK——`@mcp.tool()` 在真实实现里只做注册、装饰器返回原函数，
所以用一个 stub 顶掉 `mcp.server.fastmcp` 就能 import 到普通函数。

用法（由 run.sh 调用，也可单独跑）：
    python3 py_side.py <path-to-course_stdio_server/__main__.py>
"""

import importlib.util
import json
import sys
import types
from pathlib import Path


def _install_mcp_stub() -> None:
    fake = types.ModuleType("mcp")
    srv = types.ModuleType("mcp.server")
    fm = types.ModuleType("mcp.server.fastmcp")

    class FastMCP:
        def __init__(self, name):
            self.name = name

        def tool(self, *_a, **_k):
            def deco(fn):
                return fn

            return deco

    fm.FastMCP = FastMCP
    sys.modules["mcp"] = fake
    sys.modules["mcp.server"] = srv
    sys.modules["mcp.server.fastmcp"] = fm


def main() -> None:
    _install_mcp_stub()
    src = Path(sys.argv[1])
    spec = importlib.util.spec_from_file_location("course_srv", src)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)

    # 与 ts_side.mjs 的用例集**必须逐条对应**，包括 key 的写法——diff 是逐行比的，
    # 一边加了用例另一边没加会表现成一大段差异而不是「少了一个用例」。
    out = {
        "get_lesson": json.loads(m.get_lesson()),
        "get_course_catalog": json.loads(m.get_course_catalog()),
        "get_trial_slots": json.loads(m.get_trial_slots()),
        "get_weekly_report@2026-08-10": json.loads(m.get_weekly_report("2026-08-10")),
        # 非法 week_of 退回全部行（不是报错），这条锁住那个行为
        "get_weekly_report@bogus": json.loads(m.get_weekly_report("not-a-date")),
        "get_student_progress@stu-001": json.loads(m.get_student_progress("stu-001")),
        "get_student_progress@stu-003": json.loads(m.get_student_progress("stu-003")),
        # 不存在的学生走 attempts=0 分支
        "get_student_progress@missing": json.loads(m.get_student_progress("nope")),
        "present_slide": json.loads(
            m.present_slide(
                title="标题",
                body="正文",
                visual={"kind": "objects", "emoji": "🍎", "groups": [9, 4]},
                kind="intro",
                note="备注",
            )
        ),
        "present_exercise": json.loads(
            m.present_exercise(
                prompt="9+4=?",
                options=["12", "13", "14"],
                answer_index=1,
                hint="先凑十",
                explain="9+1=10",
            )
        ),
        # present_report 的 camelCase→snake_case 归一化是最容易移植错的一处
        "present_report": json.loads(
            m.present_report(
                title="周报",
                week_of="2026-08-10",
                class_summary={"totalAttempts": 10, "activeStudents": 3, "accuracy": 0.5},
                knowledge_points=[{"knowledgePoint": "x", "avgDurationMs": 100}],
                alerts=[{"knowledgePoint": "x", "consecutiveWrong": 3}],
                data_quality={"acceptedRows": 10, "rejectedRows": 1},
            )
        ),
        "present_suggestions": json.loads(m.present_suggestions(["再来一题", "换个例子"])),
    }
    print(json.dumps(out, ensure_ascii=False, sort_keys=True, indent=1))


if __name__ == "__main__":
    main()
