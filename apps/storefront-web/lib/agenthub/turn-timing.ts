/**
 * 情景对话一个语音回合在**客户端**的时刻：页面打点、`POST /api/agenthub/turn-timing` 上报、
 * 服务端校验后写一行结构化日志。两头共用这一份定义，字段和上限不会漂。
 *
 * 为什么要有它：拆「松手 → 店员句」8.5–14.9 s 时，服务端各段都有读数（平台的回合与事件记录、
 * 合成段就绪的 `voice.tts.segment_ready`），客户端那 ~1 s 与「首段
 * 可播」读不到。这里补的就是客户端那一头，用 `turnId` 与服务端分段接起来。
 *
 * 时刻都是**相对松手**的毫秒（`performance.now()` 之差，单调、不受改系统时间影响），另带
 * 一个松手的绝对时刻 `t0`（epoch ms），对账服务端时间戳用（客户端时钟可能有偏差，差值以
 * 相对量为准）。
 *
 * 只收数字和 id：`sessionId` / `turnId` 必须是 UUID，其余全是有界非负整数；多一个键、
 * 多一个字符串都整条拒掉——这条日志不能变成谁都能往里写字的口子。
 */

/** 打点的名字（顺序就是一回合里正常的先后）。 */
export const TURN_TIMING_MARKS = [
  /** 松手（按住说话的按钮抬起）。恒为 0，留着是为了一眼看出这一行从哪起算。 */
  "release",
  /** `/api/agenthub/voice-turn` 回包：上传 + 派发（平台在派发里同步转写）+ 读出转写。 */
  "uploaded",
  /** 店员这句的首个正文 delta 画到页面上（SSE；渲染提交的时刻，比 delta 到达晚几 ms）。 */
  "firstText",
  /** 读接口第一次带回段 0。 */
  "seg0Ready",
  /** 段 0 的 `<audio>` 触发 `canplay`。 */
  "seg0CanPlay",
  /** 第一段开始出声（`<audio>` 的 `playing`）。 */
  "playStart",
  /** 页面收到回合终态（`/api/agenthub/turn-result` 回了非 pending）。 */
  "settled",
] as const;

export type TurnTimingMark = (typeof TURN_TIMING_MARKS)[number];

/** 音频这一路的计数。 */
export const TURN_TIMING_COUNTS = [
  /** 读了几次 `turn-audio`（每回合请求数）。 */
  "reads",
  /** 放完的段数。 */
  "played",
  /** 没放出来的段数。 */
  "skipped",
] as const;

export type TurnTimingCount = (typeof TURN_TIMING_COUNTS)[number];

export interface TurnTimingReport {
  sessionId: string;
  turnId: string;
  /** 松手的 epoch ms。 */
  t0: number;
  marks: Partial<Record<TurnTimingMark, number>>;
  audio: Partial<Record<TurnTimingCount, number>>;
}

/** 请求体字节上限。一条满的上报约 330 字节。 */
export const TURN_TIMING_MAX_BYTES = 1024;
/** 单个时刻的上限：10 分钟（回合等待的上限是 200 s + 一次请求 20 s，再加音频 30 s）。 */
export const TURN_TIMING_MAX_MARK_MS = 600_000;
export const TURN_TIMING_MAX_COUNT = 1000;
/** `t0` 与服务端时钟最多差一天（再远就是瞎填的）。 */
export const TURN_TIMING_MAX_SKEW_MS = 86_400_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInt(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

/** 校验一条上报的请求体（还没 parse 的原文）。`now` = 服务端时钟。 */
export function parseTurnTimingReport(
  raw: string,
  now: number,
): { ok: true; report: TurnTimingReport } | { ok: false; error: string } {
  if (new TextEncoder().encode(raw).length > TURN_TIMING_MAX_BYTES) return { ok: false, error: "too_large" };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "bad_json" };
  }
  if (!isPlainObject(body)) return { ok: false, error: "bad_shape" };
  for (const key of Object.keys(body)) {
    if (key !== "sessionId" && key !== "turnId" && key !== "t0" && key !== "marks" && key !== "audio") {
      return { ok: false, error: "unknown_field" };
    }
  }
  const { sessionId, turnId, t0, marks, audio } = body;
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) return { ok: false, error: "bad_session_id" };
  if (typeof turnId !== "string" || !UUID.test(turnId)) return { ok: false, error: "bad_turn_id" };
  if (typeof t0 !== "number" || !Number.isInteger(t0) || Math.abs(t0 - now) > TURN_TIMING_MAX_SKEW_MS) {
    return { ok: false, error: "bad_t0" };
  }
  if (!isPlainObject(marks)) return { ok: false, error: "bad_marks" };
  const outMarks: TurnTimingReport["marks"] = {};
  for (const [key, value] of Object.entries(marks)) {
    if (!(TURN_TIMING_MARKS as readonly string[]).includes(key)) return { ok: false, error: "unknown_mark" };
    const ms = boundedInt(value, TURN_TIMING_MAX_MARK_MS);
    if (ms === null) return { ok: false, error: "bad_mark" };
    outMarks[key as TurnTimingMark] = ms;
  }
  if (Object.keys(outMarks).length === 0) return { ok: false, error: "no_marks" };
  const outAudio: TurnTimingReport["audio"] = {};
  if (audio !== undefined) {
    if (!isPlainObject(audio)) return { ok: false, error: "bad_audio" };
    for (const [key, value] of Object.entries(audio)) {
      if (!(TURN_TIMING_COUNTS as readonly string[]).includes(key)) return { ok: false, error: "unknown_count" };
      const n = boundedInt(value, TURN_TIMING_MAX_COUNT);
      if (n === null) return { ok: false, error: "bad_count" };
      outAudio[key as TurnTimingCount] = n;
    }
  }
  return { ok: true, report: { sessionId: sessionId.toLowerCase(), turnId: turnId.toLowerCase(), t0, marks: outMarks, audio: outAudio } };
}

/**
 * 日志里那一行：校验过的上报，加上几个现成的差值（读日志的人不用自己减）。缺的时刻不出现，
 * 差值也就不出现——不填 0，不编。
 */
export function turnTimingLogRecord(report: TurnTimingReport): Record<string, unknown> {
  const { marks } = report;
  const since = (mark: TurnTimingMark) => marks[mark];
  const diff = (a: TurnTimingMark, b: TurnTimingMark) => {
    const x = marks[a];
    const y = marks[b];
    return x === undefined || y === undefined ? undefined : x - y;
  };
  const derived: Record<string, number> = {};
  const put = (name: string, value: number | undefined) => {
    if (value !== undefined) derived[name] = value;
  };
  put("releaseToFirstTextMs", since("firstText"));
  put("releaseToPlayStartMs", since("playStart"));
  put("releaseToSettledMs", since("settled"));
  put("canplayMinusSettledMs", diff("seg0CanPlay", "settled"));
  return { ...report, ...derived };
}

/**
 * 客户端：把一回合的 `performance.now()` 时刻折成上报体。`release` 是起点；没打到的时刻
 * 直接不带（不填假数）。
 */
export function buildTurnTimingReport(input: {
  sessionId: string;
  turnId: string;
  /** 松手的 epoch ms。 */
  t0: number;
  /** 各时刻的 `performance.now()`。 */
  at: Partial<Record<TurnTimingMark, number>>;
  audio?: Partial<Record<TurnTimingCount, number>>;
}): TurnTimingReport {
  const release = input.at.release ?? 0;
  const marks: TurnTimingReport["marks"] = {};
  for (const mark of TURN_TIMING_MARKS) {
    const at = input.at[mark];
    if (at === undefined) continue;
    marks[mark] = Math.min(Math.max(Math.round(at - release), 0), TURN_TIMING_MAX_MARK_MS);
  }
  const audio: TurnTimingReport["audio"] = {};
  for (const key of TURN_TIMING_COUNTS) {
    const n = input.audio?.[key];
    if (n !== undefined) audio[key] = Math.min(Math.max(Math.round(n), 0), TURN_TIMING_MAX_COUNT);
  }
  return { sessionId: input.sessionId, turnId: input.turnId, t0: Math.round(input.t0), marks, audio };
}
