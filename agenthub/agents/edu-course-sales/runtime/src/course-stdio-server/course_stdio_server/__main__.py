"""course stdio MCP server：把豆豆学堂的课程目录、试听名额、每周学习报告等工具
经 stdio 暴露给沙箱里的 Claude Code CLI，一个进程对应一个 AgentHub session。

设计说明：

- **用 FastMCP 而非低层 Server API**：这里的每个工具都是固定签名的函数，不需要
  像 storefront-stdio-server 那样按工具名做泛型分发，所以 ``@mcp.tool()`` 逐个装饰
  即可；装饰器在 mcp>=1.2 下返回原函数，验收脚本能直接 import 到普通函数。
- **数据文件是包内固定快照**：``course_stdio_server/data/`` 下的 JSON/CSV 是
  apps/storefront-web/data/course/ 拷过来的固定数据，路径用 ``Path(__file__).parent``
  解析，与 cwd 无关（沙箱内 cwd 不可信）。
- **周报是唯一数字来源，必须真算**：get_weekly_report 从 CSV 现算 classSummary、
  knowledgePoints、students（含按 answered_at 排序判定的连续错 alert）和
  dataQuality，不允许硬编码。
- **展示工具只拼 UI 信封**：前端按
  ``{"displayed", "component", "payload"}`` 逐字节解析，任何字段名或形状写错都
  渲染不出来，所以统一走 _envelope 生成，不再手拼 JSON。
"""

from __future__ import annotations

import csv
import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path

from mcp.server.fastmcp import FastMCP

# 包内数据快照：与 apps/storefront-web/data/course/ 保持一致，发布时随包携带。
DATA_DIR = Path(__file__).parent / "data"
LESSON_FILE = DATA_DIR / "lesson-carry-addition.json"
CATALOG_FILE = DATA_DIR / "catalog.json"
WEEK_FILE = DATA_DIR / "week-sample.csv"

mcp = FastMCP("course")


# ---------------------------------------------------------------------------
# 内部工具：数据读取与计算
# ---------------------------------------------------------------------------

def _read_json(name: str) -> dict:
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


def _load_week_rows() -> tuple[list[dict], int]:
    """解析周报 CSV。返回 (合法行, 被拒行数)——格式不合法的行只计入 dataQuality，
    不影响其它统计。answered_at 转成 datetime 以便排序与按周过滤。"""
    rows: list[dict] = []
    rejected = 0
    with WEEK_FILE.open(encoding="utf-8") as f:
        for raw in csv.DictReader(f):
            try:
                correct = int(raw["correct"])
                if correct not in (0, 1):
                    raise ValueError
                rows.append(
                    {
                        "student_id": raw["student_id"],
                        "knowledge_point": raw["knowledge_point"],
                        "correct": correct,
                        "duration_ms": int(raw["duration_ms"]),
                        "answered_at": datetime.fromisoformat(raw["answered_at"]),
                    }
                )
            except (KeyError, TypeError, ValueError):
                rejected += 1
    return rows, rejected


def _in_week(when: datetime, week_of: date) -> bool:
    return week_of <= when.date() < week_of + timedelta(days=7)


def _detect_alerts(rows: list[dict]) -> list[dict]:
    """同一知识点连续错 >=3 次算一条 alert。rows 已按 answered_at 升序；
    中途换知识点（无论对错）都会打断连续段。"""
    alerts: list[dict] = []
    run_kp = None
    run_len = 0
    for r in rows:
        if r["correct"] == 0:
            if r["knowledge_point"] == run_kp:
                run_len += 1
            else:
                run_kp = r["knowledge_point"]
                run_len = 1
        else:
            if run_len >= 3:
                alerts.append(
                    {"knowledge_point": run_kp, "consecutive_wrong": run_len}
                )
            run_kp = None
            run_len = 0
    if run_len >= 3:
        alerts.append({"knowledge_point": run_kp, "consecutive_wrong": run_len})
    return alerts


# ---------------------------------------------------------------------------
# 读数据工具
# ---------------------------------------------------------------------------

@mcp.tool()
def get_lesson(lesson_id: str = "carry-addition") -> str:
    """这节课的教学大纲：教学目标 + 建议的推进顺序 + 每一步的要点。

    ⚠️ 这是**给你参考的备课思路，不是要你照搬的页面**。课件由你自己用
    present_slide 现编——每一页的标题、讲解、教具都你来定，可以按大纲走，
    也可以根据孩子的反应临时加一页、换个例子、退回去重讲。
    """
    data = _read_json("lesson-carry-addition.json")
    return json.dumps(
        {
            "lesson_id": data["lesson_id"],
            "title": data["title"],
            "grade": data["grade"],
            "objective": data["objective"],
            "outline": [
                {
                    "step": i + 1,
                    "kind": s["kind"],
                    "点": s["title"],
                    "备课提示": s.get("teacher_note", ""),
                }
                for i, s in enumerate(data["slides"])
            ],
            "可用教具": {
                "ten_frame": "十格阵。frames 传每一组的个数，如 [9, 4]；labels 可选，如 [\"原来有\", \"又给了\"]。超过 10 的部分会画在框外。",
                "number_bond": "数字分解。whole 是整体，parts 是拆成的两份，如 whole=4, parts=[1,3]。",
                "steps": "分步算式。steps 是每一步的式子，captions 是每一步下面的小字。",
                "objects": "实物图。emoji 传一个表情（🍎🍬🦆⭐），groups 传每组个数如 [9,4]。最直观，导入和低年级优先用这个。",
                "none": "不需要图。",
            },
        },
        ensure_ascii=False,
    )


@mcp.tool()
def get_course_catalog() -> str:
    """读 catalog.json 的 courses 字段，作为 JSON 字符串返回。"""
    return json.dumps(_read_json("catalog.json")["courses"], ensure_ascii=False)


@mcp.tool()
def get_trial_slots() -> str:
    """读 catalog.json 的 trial_slots 字段，作为 JSON 字符串返回。"""
    return json.dumps(_read_json("catalog.json")["trial_slots"], ensure_ascii=False)


@mcp.tool()
def get_weekly_report(week_of: str = "2026-08-10") -> str:
    """从周报 CSV 现算一周汇总：classSummary / knowledgePoints / students（含连续错
    alert）/ dataQuality。week_of 是该周的周一；不在这周内的行不参与统计。"""
    rows, rejected = _load_week_rows()
    try:
        start = date.fromisoformat(week_of)
    except ValueError:
        start = None  # week_of 非法时退回全部行，避免一次查询失败
    week_rows = [r for r in rows if start is None or _in_week(r["answered_at"], start)]

    total = len(week_rows)
    class_summary = {
        "totalAttempts": total,
        "activeStudents": len({r["student_id"] for r in week_rows}),
        "accuracy": (sum(r["correct"] for r in week_rows) / total) if total else 0,
    }

    by_kp: dict[str, list[dict]] = {}
    by_student: dict[str, list[dict]] = {}
    for r in week_rows:
        by_kp.setdefault(r["knowledge_point"], []).append(r)
        by_student.setdefault(r["student_id"], []).append(r)

    knowledge_points = []
    for kp in sorted(by_kp):
        rs = by_kp[kp]
        attempts = len(rs)
        accuracy = sum(r["correct"] for r in rs) / attempts
        knowledge_points.append(
            {
                "knowledge_point": kp,
                "attempts": attempts,
                "accuracy": accuracy,
                "avg_duration_ms": round(sum(r["duration_ms"] for r in rs) / attempts),
                "struggling": accuracy < 0.6,
            }
        )

    students = []
    for sid in sorted(by_student):
        rs = sorted(by_student[sid], key=lambda r: r["answered_at"])
        students.append(
            {
                "studentId": sid,
                "attempts": len(rs),
                "accuracy": sum(r["correct"] for r in rs) / len(rs),
                "alerts": _detect_alerts(rs),
            }
        )

    return json.dumps(
        {
            "classSummary": class_summary,
            "knowledgePoints": knowledge_points,
            "students": students,
            "dataQuality": {"acceptedRows": total, "rejectedRows": rejected},
        },
        ensure_ascii=False,
    )


@mcp.tool()
def get_student_progress(student_id: str) -> str:
    """取单个学生的分知识点正确率与最近一次作答时间（全部历史行，不做周过滤，
    教师关注的是长期掌握度）。"""
    rows, _ = _load_week_rows()
    mine = [r for r in rows if r["student_id"] == student_id]
    if not mine:
        return json.dumps(
            {"student_id": student_id, "attempts": 0, "knowledge_points": [], "last_answered_at": None},
            ensure_ascii=False,
        )
    by_kp: dict[str, list[dict]] = {}
    for r in mine:
        by_kp.setdefault(r["knowledge_point"], []).append(r)
    knowledge_points = []
    for kp in sorted(by_kp):
        rs = by_kp[kp]
        knowledge_points.append(
            {
                "knowledge_point": kp,
                "attempts": len(rs),
                "accuracy": sum(r["correct"] for r in rs) / len(rs),
                "last_answered_at": max(r["answered_at"] for r in rs).isoformat(),
            }
        )
    return json.dumps(
        {
            "student_id": student_id,
            "attempts": len(mine),
            "knowledge_points": knowledge_points,
            "last_answered_at": max(r["answered_at"] for r in mine).isoformat(),
        },
        ensure_ascii=False,
    )


# ---------------------------------------------------------------------------
# 展示工具：统一走 _envelope，保证前端能逐字节解析
# ---------------------------------------------------------------------------

def _snake(value):
    """camelCase → snake_case，只处理一层 dict 的键名。"""
    if not isinstance(value, dict):
        return value
    out = {}
    for key, item in value.items():
        snake = re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower()
        out[snake] = item
    return out


def _envelope(component: str, payload: dict) -> str:
    return json.dumps(
        {"displayed": True, "component": component, "payload": payload},
        ensure_ascii=False,
    )


@mcp.tool()
def present_slide(
    title: str,
    body: str = "",
    visual: dict | None = None,
    kind: str = "concept",
    note: str = "",
) -> str:
    """把一页课件放到孩子屏幕上。**内容你来编**，不是从固定课件里挑。

    title  这一页最大的那行字，短，是这一页要说的那件事。
    body   讲解正文，两三句，孩子能一口气读完。
    visual 教具，形状见 get_lesson 的「可用教具」。不需要图就不传。
    kind   intro / concept / worked / practice / summary，只影响页角的小标签。
    note   补一句页面正文之外的话（提问、提醒、鼓励），可留空。

    每一页只讲一件事。要讲三件事就翻三页，不要堆在一页里。
    """
    payload: dict = {"title": title, "kind": kind}
    if body:
        payload["body"] = body
    if visual:
        payload["visual"] = visual
    if note:
        payload["note"] = note
    return _envelope("slide", payload)


@mcp.tool()
def present_exercise(
    prompt: str,
    options: list[str],
    answer_index: int,
    hint: str = "",
    explain: str = "",
    visual: dict | None = None,
) -> str:
    """出一道让孩子点选的题。题目你自己编，难度跟着孩子当下的状态走。

    options 两到三个，answer_index 是正确选项的下标（从 0 开始）。
    hint    答错时先给的那一层小提示，不要直接给答案。
    explain 答对之后显示的一句话解释。
    visual  这道题配的教具，可选。

    出完题就停下来等孩子点，不要自己把答案说出来。
    """
    payload: dict = {
        "prompt": prompt,
        "options": options,
        "answer_index": answer_index,
    }
    if hint:
        payload["hint"] = hint
    if explain:
        payload["explain"] = explain
    if visual:
        payload["visual"] = visual
    return _envelope("exercise", payload)


@mcp.tool()
def present_course_plan(
    title: str,
    level: str,
    sessions: int,
    weeks: int,
    price: int,
    original_price: int,
    highlights: list[str],
    note: str,
) -> str:
    """课程方案卡：price/original_price 用整数元，highlights 是卖点列表。"""
    return _envelope(
        "course_plan",
        {
            "title": title,
            "level": level,
            "sessions": sessions,
            "weeks": weeks,
            "price": price,
            "original_price": original_price,
            "highlights": highlights,
            "note": note,
        },
    )


@mcp.tool()
def present_trial_slots(title: str, slots: list[dict], note: str = "") -> str:
    """试听名额卡：slots 每项来自 get_trial_slots，只选这个孩子能上的时段。"""
    return _envelope("trial_slots", {"title": title, "slots": slots, "note": note})


@mcp.tool()
def present_correction(
    title: str, items: list[dict], summary: str = ""
) -> str:
    """错题讲解卡：items 每项 {question, student_answer, correct, where_wrong, hint}，
    hint 是给老师的讲解提示，不直接是答案。"""
    return _envelope("correction", {"title": title, "items": items, "summary": summary})


@mcp.tool()
def present_report(
    title: str,
    week_of: str,
    class_summary: dict,
    knowledge_points: list[dict],
    alerts: list[dict],
    data_quality: dict,
) -> str:
    """周报卡。数值一律来自 get_weekly_report 的返回，这里只做键名归一化。

    get_weekly_report 沿用上游 weekly-report.schema.json 的 camelCase（那是给下游
    系统的契约，不该为了前端改），而 UI 信封统一 snake_case。不在这里转换的话，
    卡片上「答题量/活跃学生」会静默显示成「—」——字段不存在不会报错，只会是空的。
    """
    return _envelope(
        "report",
        {
            "title": title,
            "week_of": week_of,
            "class_summary": _snake(class_summary),
            "knowledge_points": [_snake(k) for k in knowledge_points],
            "alerts": [_snake(a) for a in alerts],
            "data_quality": _snake(data_quality),
        },
    )


@mcp.tool()
def present_suggestions(suggestions: list[str]) -> str:
    """推荐下一步的 chips，建议用祈使句，3 个上下。"""
    return _envelope("suggestions", {"suggestions": suggestions})


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
