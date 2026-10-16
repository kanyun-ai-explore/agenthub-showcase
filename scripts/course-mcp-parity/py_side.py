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


def _call_error(fn, **kwargs) -> dict:
    """校验失败的用例：两边比的是报错原文（Python 抛 ValueError、TS 抛 Error，各自取 message）。"""
    try:
        fn(**kwargs)
        return {"error": None}
    except ValueError as err:
        return {"error": str(err)}


# present_lesson 的四类题混排，可选项有真值、空串、缺省三种（空串不该进 payload）。
LESSON_MIXED = [
    {"type": "listen_choice", "audio_text": "tea", "options": ["coffee", "tea", "milk"], "answer_index": 1, "prompt": "", "hint": "开头是 t 的音", "explain": "tea 是茶"},
    {"type": "word_bank", "prompt": "拼出：我想要一杯茶。", "bank": ["tea", "I", "a", "like", "would"], "answer": ["I", "would", "like", "a", "tea"], "hint": "先找主语"},
    {"type": "fill_blank", "sentence": "I ___ a cake.", "options": ["like", "likes"], "answer_index": 0, "explain": "I 后面用 like"},
    {"type": "read_aloud", "text": "Thank you very much", "prompt": "跟我读：", "hint": "", "explain": "very much 加强语气", "extra": "不认识的字段不进 payload"},
]


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
        "present_listen_choice": json.loads(
            m.present_listen_choice(
                audio_text="coffee",
                options=["coffee", "tea", "please"],
                answer_index=0,
                prompt="听一听，选出你听到的词",
                hint="开头是 k 的音",
                explain="coffee 是咖啡",
            )
        ),
        "present_word_bank": json.loads(
            m.present_word_bank(
                prompt="把这句话翻译成英文：我想要一杯咖啡。",
                bank=["I", "would", "like", "a", "coffee"],
                answer=["I", "would", "like", "a", "coffee"],
                hint="先找主语",
                explain="would like 是「想要」",
            )
        ),
        # 可选项全缺：空串不该被塞进 payload（两边都靠「真值才写」这条规则）
        "present_fill_blank@minimal": json.loads(
            m.present_fill_blank(
                sentence="I ___ a student.",
                options=["am", "is", "are"],
                answer_index=0,
            )
        ),
        "present_read_aloud": json.loads(
            m.present_read_aloud(
                text="I would like a coffee please",
                prompt="跟我读：",
                hint="would like 连起来读",
                explain="please 放句尾更礼貌",
            )
        ),
        "present_read_aloud@minimal": json.loads(
            m.present_read_aloud(text="I like coffee.")
        ),
        "present_lesson@mixed": json.loads(
            m.present_lesson(exercises=LESSON_MIXED, title="第 2 关", focus="分清 tea 和 coffee")
        ),
        "present_lesson@minimal": json.loads(
            m.present_lesson(exercises=[{"type": "read_aloud", "text": "I like milk."}])
        ),
        # 分批：第一批 2 道，带 lesson_id 与批次号；batch=0 不进 payload
        "present_lesson@batch": json.loads(
            m.present_lesson(lesson_id="u1-l1#3", batch=1, batches=2, exercises=LESSON_MIXED[:2])
        ),
        "present_lesson@batch-zero": json.loads(
            m.present_lesson(lesson_id="", batch=0, batches=1, exercises=LESSON_MIXED[3:])
        ),
        "present_lesson@empty": _call_error(m.present_lesson, exercises=[]),
        "present_lesson@too-long": _call_error(
            m.present_lesson, exercises=[{"type": "read_aloud", "text": "Hi"} for _ in range(13)]
        ),
        # 一次列全：缺字段 + 不认识的题型 + 不是对象，三条问题一条报错
        "present_lesson@invalid": _call_error(
            m.present_lesson,
            exercises=[
                {"type": "listen_choice", "audio_text": "tea", "answer_index": None},
                {"type": "matching", "pairs": []},
                "tea",
                {"type": "read_aloud", "text": "Hi"},
            ],
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
