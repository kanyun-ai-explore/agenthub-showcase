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


# ---------------------------------------------------------------------------
# 英语小课的四类题。形状由 EnglishCourseApp 渲染：听音选词 / 拼句 / 填空 / 跟读。
# 和 present_exercise 一样是「题」，hint / explain 的语义完全一致——答错先给小提示，
# 答对才显示解释；具体表扬留给 agent 的正文，不写死在卡里。
#
# 课程页按「一关」出题：agent 调一次 present_lesson 把整关题目交过来；四个单题工具
# 保留，别的教育 agent 和旧版本的英语 agent 仍在用。四类题的 payload 整形是同一张表
# （_EXERCISE_FIELDS），单题工具与 present_lesson 共用；TS 侧 EXERCISE_FIELDS 是它的
# 移植，scripts/course-mcp-parity 对拍。
# ---------------------------------------------------------------------------

_EXERCISE_FIELDS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "listen_choice": (("audio_text", "options", "answer_index"), ("prompt", "hint", "explain")),
    "word_bank": (("prompt", "bank", "answer"), ("hint", "explain")),
    "fill_blank": (("sentence", "options", "answer_index"), ("prompt", "hint", "explain")),
    "read_aloud": (("text",), ("prompt", "hint", "explain")),
}

# 一关最多几道。CLAUDE.md 让它出 8 道，这里只挡明显失控的长度，不卡死 8。
LESSON_MAX_EXERCISES = 12


def _exercise_payload(kind: str, fields: dict) -> dict:
    """必填项原样带上，可选项「真值才写」（空串不进 payload）。"""
    required, optional = _EXERCISE_FIELDS[kind]
    payload: dict = {key: fields.get(key) for key in required}
    for key in optional:
        if fields.get(key):
            payload[key] = fields[key]
    return payload


def _lesson_payload(
    exercises: list,
    title: str = "",
    focus: str = "",
    lesson_id: str = "",
    batch: int = 0,
    batches: int = 0,
) -> dict:
    """present_lesson 的校验 + 整形。只挡「前端根本画不出来」的那几种（不是数组、题型
    不认识、缺必填字段），一次把所有问题列全——agent 按报错整关重调一次就能改好。
    选项下标越界、answer 不在 bank 里这类内容错误不在这里挡：前端渲染前会跳过画不了的题。"""
    if not isinstance(exercises, list) or len(exercises) == 0:
        raise ValueError("present_lesson 没有出成：exercises 必须是非空数组。")
    if len(exercises) > LESSON_MAX_EXERCISES:
        raise ValueError(
            f"present_lesson 没有出成：一关最多 {LESSON_MAX_EXERCISES} 道，这次给了 {len(exercises)} 道。"
        )
    problems: list[str] = []
    shaped: list[dict] = []
    for i, item in enumerate(exercises):
        n = i + 1
        if not isinstance(item, dict):
            problems.append(f"第 {n} 道不是对象")
            continue
        kind = item.get("type")
        if not isinstance(kind, str) or kind not in _EXERCISE_FIELDS:
            problems.append(
                f"第 {n} 道的 type 不认识（只能是 listen_choice / word_bank / fill_blank / read_aloud）"
            )
            continue
        missing = [key for key in _EXERCISE_FIELDS[kind][0] if item.get(key) is None]
        if missing:
            problems.append(f"第 {n} 道（{kind}）缺 {', '.join(missing)}")
            continue
        shaped.append({"type": kind, **_exercise_payload(kind, item)})
    if problems:
        raise ValueError(f"present_lesson 没有出成：{'；'.join(problems)}。改好后整关重新调一次。")
    payload: dict = {"exercises": shaped}
    if title:
        payload["title"] = title
    if focus:
        payload["focus"] = focus
    # 分批出的一关：同一个 lesson_id，batch 从 1 数，batches 是一共几批。页面拿到第一批就开答。
    if lesson_id:
        payload["lesson_id"] = lesson_id
    if _positive_int(batch):
        payload["batch"] = batch
    if _positive_int(batches):
        payload["batches"] = batches
    return payload


def _positive_int(value) -> bool:
    # bool 是 int 的子类，True 不算批次号（与 TS 的 Number.isInteger 口径一致）。
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


@mcp.tool()
def present_listen_choice(
    audio_text: str,
    options: list[str],
    answer_index: int,
    prompt: str = "",
    hint: str = "",
    explain: str = "",
) -> str:
    """出一道「听音选词」题：语音把 audio_text 念出来，孩子选出他听到的那个。

    audio_text   要念的英文原文，只放要读的那一句（一个词或一个短语），不要带中文、不要带引号。
    options      候选词，两到四个，词性/长度接近（coffee / tea / please），不要有明显送分项。
    answer_index 正确选项的下标（从 0 开始）。
    prompt       题面那句中文指令，可留空（留空时前端显示「听一听，选出你听到的词」）。
    hint         答错时先给的那一层小提示，不要直接给答案。
    explain      答对之后显示的一句话解释。

    出完题就停下来等孩子点，不要自己把答案说出来。
    """
    return _envelope(
        "listen_choice",
        _exercise_payload(
            "listen_choice",
            {
                "audio_text": audio_text,
                "options": options,
                "answer_index": answer_index,
                "prompt": prompt,
                "hint": hint,
                "explain": explain,
            },
        ),
    )


@mcp.tool()
def present_word_bank(
    prompt: str,
    bank: list[str],
    answer: list[str],
    hint: str = "",
    explain: str = "",
) -> str:
    """出一道「拼句」题：给一堆词块，让孩子拼成一句完整的话。

    bank    词库里的词块，两到六个，**打乱顺序给**（前端不洗牌，摆放顺序就是你给的顺序）。
            可以放一个干扰词，但不要放得让孩子无从判断。
    answer  正确的词块序列，按顺序列全（每一项都要在 bank 里出现）。
    prompt  题面（比如「把这句话翻译成英文：我想要一杯咖啡。」）。
    hint    答错时先给的那一层小提示（比如「先找主语」），不要直接给答案。
    explain 答对之后显示的一句话解释。

    出完题就停下来等孩子点，不要自己把答案说出来。
    """
    return _envelope(
        "word_bank",
        _exercise_payload(
            "word_bank",
            {"prompt": prompt, "bank": bank, "answer": answer, "hint": hint, "explain": explain},
        ),
    )


@mcp.tool()
def present_fill_blank(
    sentence: str,
    options: list[str],
    answer_index: int,
    prompt: str = "",
    hint: str = "",
    explain: str = "",
) -> str:
    """出一道「填空」题：句子里挖一个空，孩子从选项里选出该填的那个。

    sentence     带空的完整句子，空位写成三个下划线 ___（只挖一个空）。
    options      候选词，两到四个。
    answer_index 正确选项的下标（从 0 开始）。
    prompt       题面那句中文指令，可留空（留空时前端显示「选出括号里该填的词」）。
    hint         答错时先给的那一层小提示，不要直接给答案。
    explain      答对之后显示的一句话解释。

    出完题就停下来等孩子点，不要自己把答案说出来。
    """
    return _envelope(
        "fill_blank",
        _exercise_payload(
            "fill_blank",
            {
                "sentence": sentence,
                "options": options,
                "answer_index": answer_index,
                "prompt": prompt,
                "hint": hint,
                "explain": explain,
            },
        ),
    )


@mcp.tool()
def present_read_aloud(
    text: str,
    prompt: str = "",
    hint: str = "",
    explain: str = "",
) -> str:
    """出一道「跟读」题：屏幕上一句英文，孩子按住按钮把它读出来，平台把他说的话转写成
    文字，再跟原句逐词比对给他看。

    text    要孩子跟读的英文句子，**完整的一句话**，三到八个词，别太长。只放英文，不要带中文、
            引号和音标。这一句也是范例音要念的内容（站点自己的 TTS）。
    prompt  题面那句中文指令，可留空（留空时前端显示「跟我读：」）。
    hint    读得不对或不完整时给的那层小提示（比如「中间的 would like 连起来读」），不要直接给答案。
    explain 读对了之后显示的一句话解释。

    **这道题没有发音分**：比对只看转写出来的词对不对，转写模型还会顺手把读音纠成正确的词，
    所以结果偏乐观，别拿它当评测结论，也别在点评里说「发音很标准」这类话。
    出完题就停下来等孩子读，不要自己把句子念一遍，也不要替他说答案。
    """
    return _envelope(
        "read_aloud",
        _exercise_payload("read_aloud", {"text": text, "prompt": prompt, "hint": hint, "explain": explain}),
    )


@mcp.tool()
def present_lesson(
    exercises: list[dict],
    title: str = "",
    focus: str = "",
    lesson_id: str = "",
    batch: int = 0,
    batches: int = 0,
) -> str:
    """出一关的题（一关 8 道，可以分批交）：exercises 是这一批的题目，页面拿到后在本地一题一题放、
    本地判分，孩子作答期间不再找你。

    exercises  数组，每一项是一道题：{"type": <题型>, ...这个题型的字段}。四种题型的字段和单题工具
               完全一样：
               listen_choice  audio_text, options, answer_index, prompt?, hint?, explain?
               word_bank      prompt, bank, answer, hint?, explain?
               fill_blank     sentence, options, answer_index, prompt?, hint?, explain?
               read_aloud     text, prompt?, hint?, explain?
               每个字段怎么写，见 present_listen_choice / present_word_bank / present_fill_blank /
               present_read_aloud 的说明：hint 不能是答案；answer 的每一项都要在 bank 里；sentence
               只挖一个 ___；read_aloud 的 text 是三到八个词的一整句英文。
    title      这一关的标题，可留空。
    focus      这一关专门练什么，一句中文（比如「would like 的语序；分清 tea 和 coffee」），显示在
               关卡开头。按上一关的错题出题时，把那几个错过的点写在这里。
    lesson_id  这一关的编号，原样抄消息里给的那个。
    batch      分批出时这是第几批（从 1 数）；batches 是一共几批。消息让你分两批出时，先调一次
    batches    （batch=1, batches=2）给前 2 道，页面拿到就开始答；再调一次（batch=2, batches=2）给剩下
               的，两次 lesson_id 相同。不分批时 batch、batches 都填 1。

    题型混着排，同一种不要连着出；跟读放一到两道。缺字段或题型写错会整批报错，按报错改好后这一批
    重新调一次。
    """
    return _envelope("lesson", _lesson_payload(exercises, title, focus, lesson_id, batch, batches))


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
