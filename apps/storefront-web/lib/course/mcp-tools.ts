/**
 * course MCP 的工具实现（TypeScript 移植）。
 *
 * 为什么是移植而不是继续用 Python：`always_ask` 这类工具级人工审批只在**经网关的
 * remote MCP** 上有强制点，stdio 传输前面没有网关，平台在发布期会直接拒掉这种声明。
 * 要拿到审批就必须把 course 换成 HTTP MCP，而本仓库只部署了一个 Node 服务，没有
 * 跑 Python 的地方——新起一个服务的代价远大于移植这 415 行，所以搬进已部署的站点。
 *
 * 上游对照：`shared/course-stdio-server/course_stdio_server/__main__.py`。
 * 两边**共享同一份数据文件**（`apps/storefront-web/data/course/`，Python 那份是
 * 从这里拷过去的包内快照，三个文件逐字节一致），所以数据不会分叉。
 *
 * 工具描述文案逐字搬运：它们是提示词的一部分，agent 的教学行为（每页只讲一件事、
 * 出完题停下来等孩子点）就写在里面，改措辞就是改行为。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Lesson } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "course");

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(DATA_DIR, name), "utf8")) as T;
}

// ---------------------------------------------------------------------------
// 内部工具：数据读取与计算
// ---------------------------------------------------------------------------

interface WeekRow {
  student_id: string;
  knowledge_point: string;
  correct: number;
  duration_ms: number;
  /** 绝对时刻，用于排序。 */
  answered_at: number;
  /** ISO 串的前 10 位。CSV 里带显式 `+08:00`，Python 的 `.date()` 取的是该偏移下的
   *  日历日；直接切字符串与之等价，且不引入本机时区。 */
  answered_day: string;
  /** CSV 里的原文（带 `+08:00`）。对外返回一律用它，**不要** `new Date(...).toISOString()`——
   *  那会把 09:00+08:00 变成 01:00Z，同一时刻但老师读到的是错的钟点。上游 Python 返回的是
   *  aware datetime 的 isoformat()，保留原偏移。 */
  answered_raw: string;
}

/**
 * 解析周报 CSV。返回 `{rows, rejected}`——格式不合法的行只计入 dataQuality，
 * 不影响其它统计。
 */
async function loadWeekRows(): Promise<{ rows: WeekRow[]; rejected: number }> {
  const text = await readFile(path.join(DATA_DIR, "week-sample.csv"), "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = (lines.shift() ?? "").split(",");
  const idx = (name: string) => header.indexOf(name);
  const iStudent = idx("student_id");
  const iKp = idx("knowledge_point");
  const iCorrect = idx("correct");
  const iDuration = idx("duration_ms");
  const iAnswered = idx("answered_at");

  const rows: WeekRow[] = [];
  let rejected = 0;
  for (const line of lines) {
    const cells = line.split(",");
    const correct = Number(cells[iCorrect]);
    const duration = Number(cells[iDuration]);
    const answered = cells[iAnswered];
    const at = answered ? Date.parse(answered) : Number.NaN;
    // 上游的 except 分支覆盖 KeyError/TypeError/ValueError；这里等价地要求
    // 五个字段都在、correct 是 0/1、duration 是数、时间戳可解析。
    if (
      !cells[iStudent] ||
      !cells[iKp] ||
      (correct !== 0 && correct !== 1) ||
      !Number.isFinite(duration) ||
      !Number.isFinite(at)
    ) {
      rejected += 1;
      continue;
    }
    rows.push({
      student_id: cells[iStudent],
      knowledge_point: cells[iKp],
      correct,
      duration_ms: duration,
      answered_at: at,
      answered_day: answered.slice(0, 10),
      answered_raw: answered,
    });
  }
  return { rows, rejected };
}

/** `week_of <= day < week_of + 7d`，按日历日比较（字符串序即日期序）。 */
function inWeek(day: string, weekOf: string): boolean {
  const start = Date.parse(`${weekOf}T00:00:00Z`);
  const end = start + 7 * 24 * 3600 * 1000;
  const d = Date.parse(`${day}T00:00:00Z`);
  return d >= start && d < end;
}

/**
 * 同一知识点连续错 >=3 次算一条 alert。`rows` 已按 answered_at 升序；
 * 中途换知识点（无论对错）都会打断连续段。
 */
function detectAlerts(rows: WeekRow[]): { knowledge_point: string; consecutive_wrong: number }[] {
  const alerts: { knowledge_point: string; consecutive_wrong: number }[] = [];
  let runKp: string | null = null;
  let runLen = 0;
  for (const r of rows) {
    if (r.correct === 0) {
      if (r.knowledge_point === runKp) {
        runLen += 1;
      } else {
        runKp = r.knowledge_point;
        runLen = 1;
      }
    } else {
      if (runLen >= 3 && runKp !== null) {
        alerts.push({ knowledge_point: runKp, consecutive_wrong: runLen });
      }
      runKp = null;
      runLen = 0;
    }
  }
  if (runLen >= 3 && runKp !== null) {
    alerts.push({ knowledge_point: runKp, consecutive_wrong: runLen });
  }
  return alerts;
}

/** 一组行里最晚那条的 `answered_at` 原文。见 `answered_raw` 的说明：不经 Date 往返。 */
function latestRaw(rows: WeekRow[]): string {
  return rows.reduce((best, r) => (r.answered_at > best.answered_at ? r : best)).answered_raw;
}

/** 按 key 分组；`Map.set().get()!` 那种链式写法太容易读错，单独一个 helper。 */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** camelCase → snake_case，只处理一层 dict 的键名。 */
function snake<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key.replace(/(?!^)([A-Z])/g, "_$1").toLowerCase()] = item;
  }
  return out;
}

function envelope(component: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ displayed: true, component, payload });
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, never>) => Promise<string> | string;
}

const S = { type: "string" } as const;
const I = { type: "integer" } as const;
const OBJ = { type: "object" } as const;
const strings = { type: "array", items: { type: "string" } } as const;
const objects = { type: "array", items: { type: "object" } } as const;

function obj(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required };
}

// biome-ignore lint/suspicious/noExplicitAny: 工具入参在 JSON-RPC 边界是 unknown，
// 每个 handler 自己按 inputSchema 取字段；给每个工具单独造类型只是噪音。
type Args = any;

// ---------------------------------------------------------------------------
// 英语小课四类题的 payload 整形。单题工具（present_listen_choice …）与整关的
// present_lesson 共用这一张表：同一道题不管从哪条路出，前端拿到的形状都一样。
// 规则同其它展示工具：必填项原样带上，可选项「真值才写」（空串不进 payload）。
// Python 侧 `_EXERCISE_FIELDS` 是同一张表，scripts/course-mcp-parity 对拍。
// ---------------------------------------------------------------------------

export const EXERCISE_FIELDS = {
  listen_choice: { required: ["audio_text", "options", "answer_index"], optional: ["prompt", "hint", "explain"] },
  word_bank: { required: ["prompt", "bank", "answer"], optional: ["hint", "explain"] },
  fill_blank: { required: ["sentence", "options", "answer_index"], optional: ["prompt", "hint", "explain"] },
  read_aloud: { required: ["text"], optional: ["prompt", "hint", "explain"] },
} as const;

export type ExerciseType = keyof typeof EXERCISE_FIELDS;

/** 一关最多几道。CLAUDE.md 让它出 8 道，这里只挡明显失控的长度，不卡死 8。 */
export const LESSON_MAX_EXERCISES = 12;

function isExerciseType(value: unknown): value is ExerciseType {
  return typeof value === "string" && Object.hasOwn(EXERCISE_FIELDS, value);
}

function exercisePayload(type: ExerciseType, a: Args): Record<string, unknown> {
  const { required, optional } = EXERCISE_FIELDS[type];
  const payload: Record<string, unknown> = {};
  for (const key of required) payload[key] = a?.[key];
  for (const key of optional) if (a?.[key]) payload[key] = a[key];
  return payload;
}

/**
 * present_lesson 的校验 + 整形。只挡「前端根本画不出来」的那几种（不是数组、题型不认识、
 * 缺必填字段），一次把所有问题列全——agent 按报错整关重调一次就能改好，不用来回试。
 * 选项下标越界、answer 不在 bank 里这类内容错误不在这里挡：前端渲染前会跳过画不了的题。
 */
function lessonPayload(a: Args): Record<string, unknown> {
  const raw: unknown = a?.exercises;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("present_lesson 没有出成：exercises 必须是非空数组。");
  }
  if (raw.length > LESSON_MAX_EXERCISES) {
    throw new Error(`present_lesson 没有出成：一关最多 ${LESSON_MAX_EXERCISES} 道，这次给了 ${raw.length} 道。`);
  }
  const problems: string[] = [];
  const exercises: Record<string, unknown>[] = [];
  raw.forEach((item: unknown, i: number) => {
    const n = i + 1;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      problems.push(`第 ${n} 道不是对象`);
      return;
    }
    const fields = item as Record<string, unknown>;
    if (!isExerciseType(fields.type)) {
      problems.push(`第 ${n} 道的 type 不认识（只能是 listen_choice / word_bank / fill_blank / read_aloud）`);
      return;
    }
    const type = fields.type;
    const missing = EXERCISE_FIELDS[type].required.filter((key) => fields[key] === undefined || fields[key] === null);
    if (missing.length > 0) {
      problems.push(`第 ${n} 道（${type}）缺 ${missing.join(", ")}`);
      return;
    }
    exercises.push({ type, ...exercisePayload(type, fields) });
  });
  if (problems.length > 0) {
    throw new Error(`present_lesson 没有出成：${problems.join("；")}。改好后整关重新调一次。`);
  }
  const payload: Record<string, unknown> = { exercises };
  if (a.title) payload.title = a.title;
  if (a.focus) payload.focus = a.focus;
  // 分批出的一关：同一个 lesson_id，batch 从 1 数，batches 是一共几批。页面拿到第一批就开答。
  if (a.lesson_id) payload.lesson_id = a.lesson_id;
  if (Number.isInteger(a.batch) && a.batch >= 1) payload.batch = a.batch;
  if (Number.isInteger(a.batches) && a.batches >= 1) payload.batches = a.batches;
  return payload;
}

export const COURSE_TOOLS: McpTool[] = [
  {
    name: "get_lesson",
    description: `这节课的教学大纲：教学目标 + 建议的推进顺序 + 每一步的要点。

⚠️ 这是**给你参考的备课思路，不是要你照搬的页面**。课件由你自己用
present_slide 现编——每一页的标题、讲解、教具都你来定，可以按大纲走，
也可以根据孩子的反应临时加一页、换个例子、退回去重讲。`,
    inputSchema: obj({ lesson_id: S }),
    handler: async (a: Args) => {
      void (a?.lesson_id ?? "carry-addition"); // 数据快照只有这一课，同上游
      const data = await readJson<Lesson & { slides: Record<string, string>[] }>(
        "lesson-carry-addition.json",
      );
      return JSON.stringify({
        lesson_id: data.lesson_id,
        title: data.title,
        grade: data.grade,
        objective: data.objective,
        outline: data.slides.map((s, i) => ({
          step: i + 1,
          kind: s.kind,
          点: s.title,
          备课提示: s.teacher_note ?? "",
        })),
        可用教具: {
          ten_frame:
            '十格阵。frames 传每一组的个数，如 [9, 4]；labels 可选，如 ["原来有", "又给了"]。超过 10 的部分会画在框外。',
          number_bond: "数字分解。whole 是整体，parts 是拆成的两份，如 whole=4, parts=[1,3]。",
          steps: "分步算式。steps 是每一步的式子，captions 是每一步下面的小字。",
          objects:
            "实物图。emoji 传一个表情（🍎🍬🦆⭐），groups 传每组个数如 [9,4]。最直观，导入和低年级优先用这个。",
          none: "不需要图。",
        },
      });
    },
  },
  {
    name: "get_course_catalog",
    description: "读 catalog.json 的 courses 字段，作为 JSON 字符串返回。",
    inputSchema: obj({}),
    handler: async () =>
      JSON.stringify((await readJson<{ courses: unknown }>("catalog.json")).courses),
  },
  {
    name: "get_trial_slots",
    description: "读 catalog.json 的 trial_slots 字段，作为 JSON 字符串返回。",
    inputSchema: obj({}),
    handler: async () =>
      JSON.stringify((await readJson<{ trial_slots: unknown }>("catalog.json")).trial_slots),
  },
  {
    name: "get_weekly_report",
    description: `从周报 CSV 现算一周汇总：classSummary / knowledgePoints / students（含连续错
alert）/ dataQuality。week_of 是该周的周一；不在这周内的行不参与统计。`,
    inputSchema: obj({ week_of: S }),
    handler: async (a: Args) => {
      const weekOf = a?.week_of ?? "2026-08-10";
      const { rows, rejected } = await loadWeekRows();
      // week_of 非法时退回全部行，避免一次查询失败（同上游）。
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(String(weekOf)) && Number.isFinite(Date.parse(`${weekOf}T00:00:00Z`));
      const weekRows = valid ? rows.filter((r) => inWeek(r.answered_day, String(weekOf))) : rows;

      const total = weekRows.length;
      const classSummary = {
        totalAttempts: total,
        activeStudents: new Set(weekRows.map((r) => r.student_id)).size,
        accuracy: total ? weekRows.reduce((s, r) => s + r.correct, 0) / total : 0,
      };

      const byKp = groupBy(weekRows, (r) => r.knowledge_point);
      const byStudent = groupBy(weekRows, (r) => r.student_id);

      const knowledgePoints = [...byKp.keys()].sort().map((kp) => {
        const rs = byKp.get(kp)!;
        const accuracy = rs.reduce((s, r) => s + r.correct, 0) / rs.length;
        return {
          knowledge_point: kp,
          attempts: rs.length,
          accuracy,
          avg_duration_ms: Math.round(rs.reduce((s, r) => s + r.duration_ms, 0) / rs.length),
          struggling: accuracy < 0.6,
        };
      });

      const students = [...byStudent.keys()].sort().map((sid) => {
        const rs = [...byStudent.get(sid)!].sort((x, y) => x.answered_at - y.answered_at);
        return {
          studentId: sid,
          attempts: rs.length,
          accuracy: rs.reduce((s, r) => s + r.correct, 0) / rs.length,
          alerts: detectAlerts(rs),
        };
      });

      return JSON.stringify({
        classSummary,
        knowledgePoints,
        students,
        dataQuality: { acceptedRows: total, rejectedRows: rejected },
      });
    },
  },
  {
    name: "get_student_progress",
    description: `取单个学生的分知识点正确率与最近一次作答时间（全部历史行，不做周过滤，
教师关注的是长期掌握度）。`,
    inputSchema: obj({ student_id: S }, ["student_id"]),
    handler: async (a: Args) => {
      const studentId = String(a?.student_id ?? "");
      const { rows } = await loadWeekRows();
      const mine = rows.filter((r) => r.student_id === studentId);
      if (mine.length === 0) {
        return JSON.stringify({
          student_id: studentId,
          attempts: 0,
          knowledge_points: [],
          last_answered_at: null,
        });
      }
      const byKp = groupBy(mine, (r) => r.knowledge_point);
      const knowledgePoints = [...byKp.keys()].sort().map((kp) => {
        const rs = byKp.get(kp)!;
        return {
          knowledge_point: kp,
          attempts: rs.length,
          accuracy: rs.reduce((s, r) => s + r.correct, 0) / rs.length,
          last_answered_at: latestRaw(rs),
        };
      });
      return JSON.stringify({
        student_id: studentId,
        attempts: mine.length,
        knowledge_points: knowledgePoints,
        last_answered_at: latestRaw(mine),
      });
    },
  },

  // -------------------------------------------------------------------------
  // 展示工具：统一走 envelope，保证前端能逐字节解析
  // -------------------------------------------------------------------------
  {
    name: "present_slide",
    description: `把一页课件放到孩子屏幕上。**内容你来编**，不是从固定课件里挑。

title  这一页最大的那行字，短，是这一页要说的那件事。
body   讲解正文，两三句，孩子能一口气读完。
visual 教具，形状见 get_lesson 的「可用教具」。不需要图就不传。
kind   intro / concept / worked / practice / summary，只影响页角的小标签。
note   补一句页面正文之外的话（提问、提醒、鼓励），可留空。

每一页只讲一件事。要讲三件事就翻三页，不要堆在一页里。`,
    inputSchema: obj({ title: S, body: S, visual: OBJ, kind: S, note: S }, ["title"]),
    handler: (a: Args) => {
      const payload: Record<string, unknown> = { title: a.title, kind: a.kind ?? "concept" };
      if (a.body) payload.body = a.body;
      if (a.visual) payload.visual = a.visual;
      if (a.note) payload.note = a.note;
      return envelope("slide", payload);
    },
  },
  {
    name: "present_exercise",
    description: `出一道让孩子点选的题。题目你自己编，难度跟着孩子当下的状态走。

options 两到三个，answer_index 是正确选项的下标（从 0 开始）。
hint    答错时先给的那一层小提示，不要直接给答案。
explain 答对之后显示的一句话解释。
visual  这道题配的教具，可选。

出完题就停下来等孩子点，不要自己把答案说出来。`,
    inputSchema: obj(
      { prompt: S, options: strings, answer_index: I, hint: S, explain: S, visual: OBJ },
      ["prompt", "options", "answer_index"],
    ),
    handler: (a: Args) => {
      const payload: Record<string, unknown> = {
        prompt: a.prompt,
        options: a.options,
        answer_index: a.answer_index,
      };
      if (a.hint) payload.hint = a.hint;
      if (a.explain) payload.explain = a.explain;
      if (a.visual) payload.visual = a.visual;
      return envelope("exercise", payload);
    },
  },
  // -------------------------------------------------------------------------
  // 英语小课的题。形状由 `EnglishCourseApp` 渲染：听音选词 / 拼句 / 填空三张点选题，
  // 加一张跟读题（跟读走平台的语音回合，前端的比对见 `lib/course/read-aloud.ts`）。
  // 课程页按「一关」出题：agent 调一次 present_lesson 把整关题目交过来；四个单题工具
  // 保留，别的教育 agent 和旧版本的英语 agent 仍在用，页面也认它们（见 lib/course/english-lesson.ts）。
  // 和 present_exercise 一样是「题」，所以 hint / explain 的语义完全一致——
  // 答错先给小提示，答对才显示解释；具体表扬留给 agent 的正文，不写死在卡里。
  // -------------------------------------------------------------------------
  {
    name: "present_listen_choice",
    description: `出一道「听音选词」题：语音把 audio_text 念出来，孩子选出他听到的那个。

audio_text   要念的英文原文，只放要读的那一句（一个词或一个短语），不要带中文、不要带引号。
options      候选词，两到四个，词性/长度接近（coffee / tea / please），不要有明显送分项。
answer_index 正确选项的下标（从 0 开始）。
prompt       题面那句中文指令，可留空（留空时前端显示「听一听，选出你听到的词」）。
hint         答错时先给的那一层小提示，不要直接给答案。
explain      答对之后显示的一句话解释。

出完题就停下来等孩子点，不要自己把答案说出来。`,
    inputSchema: obj(
      { audio_text: S, options: strings, answer_index: I, prompt: S, hint: S, explain: S },
      ["audio_text", "options", "answer_index"],
    ),
    handler: (a: Args) => envelope("listen_choice", exercisePayload("listen_choice", a)),
  },
  {
    name: "present_word_bank",
    description: `出一道「拼句」题：给一堆词块，让孩子拼成一句完整的话。

bank    词库里的词块，两到六个，**打乱顺序给**（前端不洗牌，摆放顺序就是你给的顺序）。
        可以放一个干扰词，但不要放得让孩子无从判断。
answer  正确的词块序列，按顺序列全（每一项都要在 bank 里出现）。
prompt  题面（比如「把这句话翻译成英文：我想要一杯咖啡。」）。
hint    答错时先给的那一层小提示（比如「先找主语」），不要直接给答案。
explain 答对之后显示的一句话解释。

出完题就停下来等孩子点，不要自己把答案说出来。`,
    inputSchema: obj(
      { prompt: S, bank: strings, answer: strings, hint: S, explain: S },
      ["prompt", "bank", "answer"],
    ),
    handler: (a: Args) => envelope("word_bank", exercisePayload("word_bank", a)),
  },
  {
    name: "present_fill_blank",
    description: `出一道「填空」题：句子里挖一个空，孩子从选项里选出该填的那个。

sentence     带空的完整句子，空位写成三个下划线 ___（只挖一个空）。
options      候选词，两到四个。
answer_index 正确选项的下标（从 0 开始）。
prompt       题面那句中文指令，可留空（留空时前端显示「选出括号里该填的词」）。
hint         答错时先给的那一层小提示，不要直接给答案。
explain      答对之后显示的一句话解释。

出完题就停下来等孩子点，不要自己把答案说出来。`,
    inputSchema: obj(
      { sentence: S, options: strings, answer_index: I, prompt: S, hint: S, explain: S },
      ["sentence", "options", "answer_index"],
    ),
    handler: (a: Args) => envelope("fill_blank", exercisePayload("fill_blank", a)),
  },
  {
    name: "present_read_aloud",
    description: `出一道「跟读」题：屏幕上一句英文，孩子按住按钮把它读出来，平台把他说的话转写成
文字，再跟原句逐词比对给他看。

text    要孩子跟读的英文句子，**完整的一句话**，三到八个词，别太长。只放英文，不要带中文、
        引号和音标。这一句也是范例音要念的内容（站点自己的 TTS）。
prompt  题面那句中文指令，可留空（留空时前端显示「跟我读：」）。
hint    读得不对或不完整时给的那层小提示（比如「中间的 would like 连起来读」），不要直接给答案。
explain 读对了之后显示的一句话解释。

**这道题没有发音分**：比对只看转写出来的词对不对，转写模型还会顺手把读音纠成正确的词，
所以结果偏乐观，别拿它当评测结论，也别在点评里说「发音很标准」这类话。
出完题就停下来等孩子读，不要自己把句子念一遍，也不要替他说答案。`,
    inputSchema: obj({ text: S, prompt: S, hint: S, explain: S }, ["text"]),
    handler: (a: Args) => envelope("read_aloud", exercisePayload("read_aloud", a)),
  },
  {
    name: "present_lesson",
    description: `出一关的题（一关 8 道，可以分批交）：exercises 是这一批的题目，页面拿到后在本地一题一题放、
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
重新调一次。`,
    inputSchema: obj(
      {
        exercises: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: Object.keys(EXERCISE_FIELDS) },
              audio_text: S,
              sentence: S,
              text: S,
              prompt: S,
              options: strings,
              answer_index: I,
              bank: strings,
              answer: strings,
              hint: S,
              explain: S,
            },
            required: ["type"],
          },
        },
        title: S,
        focus: S,
        lesson_id: S,
        batch: I,
        batches: I,
      },
      ["exercises"],
    ),
    handler: (a: Args) => envelope("lesson", lessonPayload(a)),
  },
  {
    name: "present_course_plan",
    description: "课程方案卡：price/original_price 用整数元，highlights 是卖点列表。",
    inputSchema: obj(
      {
        title: S,
        level: S,
        sessions: I,
        weeks: I,
        price: I,
        original_price: I,
        highlights: strings,
        note: S,
      },
      ["title", "level", "sessions", "weeks", "price", "original_price", "highlights", "note"],
    ),
    handler: (a: Args) =>
      envelope("course_plan", {
        title: a.title,
        level: a.level,
        sessions: a.sessions,
        weeks: a.weeks,
        price: a.price,
        original_price: a.original_price,
        highlights: a.highlights,
        note: a.note,
      }),
  },
  {
    name: "present_trial_slots",
    description: "试听名额卡：slots 每项来自 get_trial_slots，只选这个孩子能上的时段。",
    inputSchema: obj({ title: S, slots: objects, note: S }, ["title", "slots"]),
    handler: (a: Args) =>
      envelope("trial_slots", { title: a.title, slots: a.slots, note: a.note ?? "" }),
  },
  {
    name: "present_correction",
    description: `错题讲解卡：items 每项 {question, student_answer, correct, where_wrong, hint}，
hint 是给老师的讲解提示，不直接是答案。`,
    inputSchema: obj({ title: S, items: objects, summary: S }, ["title", "items"]),
    handler: (a: Args) =>
      envelope("correction", { title: a.title, items: a.items, summary: a.summary ?? "" }),
  },
  {
    name: "present_report",
    description: `周报卡。数值一律来自 get_weekly_report 的返回，这里只做键名归一化。

get_weekly_report 沿用上游 weekly-report.schema.json 的 camelCase（那是给下游
系统的契约，不该为了前端改），而 UI 信封统一 snake_case。不在这里转换的话，
卡片上「答题量/活跃学生」会静默显示成「—」——字段不存在不会报错，只会是空的。`,
    inputSchema: obj(
      {
        title: S,
        week_of: S,
        class_summary: OBJ,
        knowledge_points: objects,
        alerts: objects,
        data_quality: OBJ,
      },
      ["title", "week_of", "class_summary", "knowledge_points", "alerts", "data_quality"],
    ),
    handler: (a: Args) =>
      envelope("report", {
        title: a.title,
        week_of: a.week_of,
        class_summary: snake(a.class_summary ?? {}),
        knowledge_points: (a.knowledge_points ?? []).map(snake),
        alerts: (a.alerts ?? []).map(snake),
        data_quality: snake(a.data_quality ?? {}),
      }),
  },
  {
    name: "present_suggestions",
    description: "推荐下一步的 chips，建议用祈使句，3 个上下。",
    inputSchema: obj({ suggestions: strings }, ["suggestions"]),
    handler: (a: Args) => envelope("suggestions", { suggestions: a.suggestions }),
  },
];

export const COURSE_TOOLS_BY_NAME = new Map(COURSE_TOOLS.map((t) => [t.name, t]));

/** 仅供测试：把内部计算暴露出来，避免测试为了覆盖它们去走整条 JSON-RPC。 */
export const __internals = { loadWeekRows, inWeek, detectAlerts, snake, envelope, groupBy, latestRaw, lessonPayload };
