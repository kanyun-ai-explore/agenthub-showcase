/**
 * 英语小课的一关：从 agent 的回合里取出题目、本地判分、拼发给 agent 的消息。纯函数，
 * 不碰 React，`scripts/english-lesson/check.mjs` 直接 import 它跑用例。
 *
 * 题从哪来（W1）：agent 调 `present_lesson`，信封的
 * `exercises` 就是这一关的题。冷启开的那一关**分两批出**：
 * 同一个 `lesson_id`，先 `batch=1` 给 2 道、再 `batch=2` 给其余的——页面拿到第一批就开答。
 * 结算时出的下一关是一批整关（`batches=1`）。回合还在跑时流里的草稿按 toolCallId 全记
 * （`liveLessonCards`），两批并行发出、一次被拒后重调都按批次号拼。
 * 兜底：这一轮没有 `lesson` 卡、但有单题卡（`listen_choice` 这些），就按出现顺序把单题卡
 * 收成一关——站点先发、agent 后 promote 的那段时间里，生产槽位上还是旧版 agent，它只会
 * 调单题工具（不兜底就是「静默丢卡」）。
 *
 * **画不了的题在这里跳过，不在 MCP 侧挡**：MCP 只挡缺字段、题型不认识；下标越界、
 * answer 拼不出来这类内容错误到这一层才看得出来，跳过它，其余的题照常上，`dropped`
 * 计数如实带出去。
 */

import type { TurnCard } from "@/lib/agenthub/turn-parts";
import type { ReadingComparison } from "./read-aloud";

export type ExerciseType = "listen_choice" | "word_bank" | "fill_blank" | "read_aloud";

interface Common {
  prompt?: string;
  hint?: string;
  explain?: string;
}

export type Exercise =
  | ({ type: "listen_choice"; audio_text: string; options: string[]; answer_index: number } & Common)
  | ({ type: "word_bank"; prompt: string; bank: string[]; answer: string[] } & Common)
  | ({ type: "fill_blank"; sentence: string; options: string[]; answer_index: number } & Common)
  | ({ type: "read_aloud"; text: string } & Common);

export interface LessonContent {
  exercises: Exercise[];
  /**
   * 这一关的编号。**由页面盖章**（`stampLesson`：出这一关的那件活的 lesson_id），不信 agent
   * 回填的那个：第二批漏写或改写 lesson_id 时，按回填值认「是不是同一关」会让
   * 播放器认不出续上的批次，永远停在「马上就到」。`lessonFromCards` 只把 agent 回填的值带出来。
   */
  lessonId?: string;
  /** 这一关的题是不是都到齐了：分批出时第二批还没到就是 false，页面答完第一批先等着。 */
  complete: boolean;
  title?: string;
  /** agent 写的「这一关专门练什么」——按错题出的关，这里写的就是那几个错过的点。 */
  focus?: string;
  /** 收到了但画不了、被跳过的题数。 */
  dropped: number;
  /** `lesson` = 一次 present_lesson；`cards` = 兜底，从单题卡收的。 */
  source: "lesson" | "cards";
}

export const EXERCISE_TYPES: readonly ExerciseType[] = ["listen_choice", "word_bank", "fill_blank", "read_aloud"];

export const TYPE_LABEL: Record<ExerciseType, string> = {
  listen_choice: "听音选词",
  word_bank: "拼句",
  fill_blank: "填空",
  read_aloud: "跟读",
};

/** 题面缺省时显示的那句（与 present_* 工具描述里写的缺省值一致）。 */
export const DEFAULT_PROMPT: Record<ExerciseType, string> = {
  listen_choice: "听一听，选出你听到的词",
  word_bank: "把词排成一句话",
  fill_blank: "选出空里该填的词",
  read_aloud: "跟我读：",
};

const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isText);
const optional = (v: unknown): string | undefined => (isText(v) ? v : undefined);

/** 比对用的词序列：小写、去掉句末标点，多词词块拆开（`would like` 与 `would`+`like` 等价）。 */
export function sentenceWords(parts: readonly string[]): string[] {
  return parts
    .join(" ")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ""))
    .filter(Boolean);
}

/** `answer` 能不能只用 `bank` 里的词块拼出来（按次数算，同一个词块不能用两次）。 */
function answerFitsBank(bank: readonly string[], answer: readonly string[]): boolean {
  const left = new Map<string, number>();
  for (const tile of bank) left.set(tile.trim(), (left.get(tile.trim()) ?? 0) + 1);
  for (const tile of answer) {
    const n = left.get(tile.trim()) ?? 0;
    if (n === 0) return false;
    left.set(tile.trim(), n - 1);
  }
  return true;
}

/** 一道题的 payload → 能画的题；画不了返回 null（调用方计入 `dropped`）。 */
export function normalizeExercise(type: unknown, raw: unknown): Exercise | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const common: Common = { prompt: optional(p.prompt), hint: optional(p.hint), explain: optional(p.explain) };
  const clean = <T extends object>(value: T): T =>
    Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
  const choice = (options: unknown, index: unknown) =>
    isTextList(options) &&
    options.length >= 2 &&
    options.length <= 6 &&
    Number.isInteger(index) &&
    (index as number) >= 0 &&
    (index as number) < options.length;

  switch (type) {
    case "listen_choice":
      if (!isText(p.audio_text) || !choice(p.options, p.answer_index)) return null;
      return clean({
        type,
        audio_text: p.audio_text.trim(),
        options: p.options as string[],
        answer_index: p.answer_index as number,
        ...common,
      });
    case "fill_blank": {
      if (!isText(p.sentence) || !p.sentence.includes("___") || !choice(p.options, p.answer_index)) return null;
      return clean({
        type,
        sentence: p.sentence,
        options: p.options as string[],
        answer_index: p.answer_index as number,
        ...common,
      });
    }
    case "word_bank":
      if (!isTextList(p.bank) || !isTextList(p.answer) || !answerFitsBank(p.bank, p.answer)) return null;
      // word_bank 的 prompt 是必填（题面就是那句要翻译的中文），缺了用缺省题面兜住。
      return clean({
        type,
        bank: p.bank,
        answer: p.answer,
        ...common,
        prompt: common.prompt ?? DEFAULT_PROMPT.word_bank,
      });
    case "read_aloud":
      if (!isText(p.text) || sentenceWords([p.text]).length === 0) return null;
      return clean({ type, text: p.text.trim(), ...common });
    default:
      return null;
  }
}

interface LessonPayload {
  exercises?: unknown;
  title?: unknown;
  focus?: unknown;
  lesson_id?: unknown;
  batch?: unknown;
  batches?: unknown;
}

const positiveInt = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 1 ? (v as number) : undefined);

/**
 * 从**一轮**的卡片里取一关。
 * - 有 `lesson` 卡：按 `batch` 排好拼起来，同一批出现两次取后一次（agent 按报错重调过的话，
 *   后一次才是改好的）。**不按 lesson_id 分组**：一轮只会出一关（【出题】出这一关、【结算】出
 *   下一关），第二批漏写或改写 lesson_id 也还是这一关的第二批。
 *   声明的 `batches` 还没到齐 → `complete: false`。
 * - 没有 `lesson` 卡：收单题卡（兜底，见文件头）。
 * 一道能画的题都没有 → null。
 *
 * `live`（回合还在跑，卡里混着草稿入参）：
 * - 只拼**从第 1 批起连续**的那几批：第 2 批先到、第 1 批还没到时先不画，免得第 1 批后到时
 *   插到前面、把孩子手上那一题挤到别的下标；
 * - `complete` 恒为 false：草稿可能被 MCP 拒掉，只有回合终态的权威结果才能把一关标成「到齐」
 *   （否则被拒的草稿会被当成定稿，提前结算）。
 */
export function lessonFromCards(cards: readonly TurnCard[], { live = false }: { live?: boolean } = {}): LessonContent | null {
  const lessonCards = cards.filter((card) => card.component === "lesson");
  if (lessonCards.length > 0) {
    const payloadOf = (card: TurnCard) => (card.payload ?? {}) as LessonPayload;
    const lessonId = [...lessonCards].reverse().map((card) => optional(payloadOf(card).lesson_id)).find(Boolean);
    const byBatch = new Map<number, LessonPayload>();
    let declared = 1;
    for (const card of lessonCards) {
      const payload = payloadOf(card);
      byBatch.set(positiveInt(payload.batch) ?? 1, payload);
      declared = Math.max(declared, positiveInt(payload.batches) ?? 1);
    }
    const ordered: LessonPayload[] = [];
    if (live) {
      for (let n = 1; byBatch.has(n); n += 1) ordered.push(byBatch.get(n) as LessonPayload);
      if (ordered.length === 0) return null;
    } else {
      ordered.push(...[...byBatch.entries()].sort(([a], [b]) => a - b).map(([, payload]) => payload));
    }
    const raw = ordered.flatMap((payload) => (Array.isArray(payload.exercises) ? payload.exercises : []));
    const exercises = raw
      .map((item) => normalizeExercise((item as { type?: unknown } | null)?.type, item))
      .filter((item): item is Exercise => item !== null);
    if (exercises.length === 0) return null;
    // 批次号连续地到了 1..declared 才算齐（缺中间一批也算没齐）。按到手的批次数，不按 declared
    // 造数组：declared 是 agent 填的，离谱的大数不该让页面分配内存。
    const complete = !live && [...byBatch.keys()].filter((n) => n <= declared).length === declared;
    const first = ordered[0];
    return {
      exercises,
      ...(lessonId ? { lessonId } : {}),
      complete,
      title: ordered.map((p) => optional(p.title)).find(Boolean),
      focus: ordered.map((p) => optional(p.focus)).find(Boolean) ?? optional(first.focus),
      dropped: raw.length - exercises.length,
      source: "lesson",
    };
  }
  const singles = cards.filter((card) => (EXERCISE_TYPES as readonly string[]).includes(card.component));
  const exercises = singles
    .map((card) => normalizeExercise(card.component, card.payload))
    .filter((item): item is Exercise => item !== null);
  if (exercises.length === 0) return null;
  // 单题卡没有批次声明：回合还在跑时后面可能还有卡，不算齐；回合结束才算。
  return { exercises, complete: !live, dropped: singles.length - exercises.length, source: "cards" };
}

/** 给一关盖上页面自己的编号（出这一关的那件活的 lesson_id）。 */
export function stampLesson(content: LessonContent, lessonId: string): LessonContent {
  return { ...content, lessonId };
}

/**
 * 出题的回合到终态：用权威结果定下这一关。
 * - 权威结果比已经交给播放器的同一关**短**（草稿入参画出的题被 MCP 拒了、回合里也没补上）：
 *   不缩短，留着已经画出来的那几道——孩子可能已经答到后面了，缩短会让播放器下标越界。
 * - 回合里一道能画的题都没有：同一关已经有题就留着，只收掉「还有题要来」；否则 null。
 * 不论哪种，回合已经结束，后面不会再有批次 → `complete: true`。
 */
export function settleLessonContent(
  before: LessonContent | null,
  after: LessonContent | null,
  lessonId: string,
): LessonContent | null {
  const same = before && before.lessonId === lessonId ? before : null;
  if (!after) return same ? { ...same, complete: true } : null;
  const settled = { ...stampLesson(after, lessonId), complete: true };
  return same && same.exercises.length > settled.exercises.length ? { ...same, complete: true } : settled;
}

/**
 * 播放器手上这一关该用哪份内容。
 * - 槽位里还是同一关（同一个页面编号）且不比快照短：用槽位（后面的批次在这里接进来）。
 * - 否则用开关时的快照（槽位换成了别的出题结果，不能换掉手上这一关）。
 * - `supplying` = 出这一关的那件活还在跑或在排队。已经不在了，就不会再有题来，按「到齐」收尾——
 *   不然播放器会永远停在「后面的题马上就到」。
 */
export function playContentFor(snapshot: LessonContent, slot: LessonContent | null, supplying: boolean): LessonContent {
  const current =
    slot && slot.lessonId === snapshot.lessonId && slot.exercises.length >= snapshot.exercises.length ? slot : snapshot;
  return !supplying && !current.complete ? { ...current, complete: true } : current;
}

/** 流里的一次工具调用：`tool-input-start` 时只有名字，`tool-input-available` 时带上完整入参。 */
export interface ToolDraft {
  toolCallId: string;
  toolName: string;
  input?: unknown;
}

/**
 * 正在写的那次工具调用（`tool-input-available` 时入参已经齐了）当成一张 `lesson` 卡：
 * 入参到的那一刻就能画题，不用等工具执行完、结果回来。只认 `present_lesson`。
 */
export function draftLessonCard(draft: ToolDraft | undefined): TurnCard | null {
  if (!draft || !/(^|__)present_lesson$/.test(draft.toolName)) return null;
  if (typeof draft.input !== "object" || draft.input === null) return null;
  return { id: draft.toolCallId, component: "lesson", payload: draft.input };
}

/**
 * 回合还在跑时，这一轮所有 `present_lesson` 调用按**发起顺序**排成卡（草稿按
 * toolCallId 全记，不再只看最近一次）：结果已经回来的用结果（权威），还没回来的用草稿入参。
 * 按发起顺序排，`lessonFromCards` 的「同一批取后一次」才指向重调的那次——被拒的草稿没有结果，
 * 只按到达顺序拼的话，它会排在重调那次的结果后面、反过来盖掉改好的版本。
 * 没记到草稿的结果卡（流断过）排在最后。
 */
export function liveLessonCards(cards: readonly TurnCard[], drafts: readonly ToolDraft[]): TurnCard[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const used = new Set<string>();
  const ordered: TurnCard[] = [];
  for (const draft of drafts) {
    const settled = byId.get(draft.toolCallId);
    if (settled) {
      ordered.push(settled);
      used.add(settled.id);
      continue;
    }
    const card = draftLessonCard(draft);
    if (card) ordered.push(card);
  }
  for (const card of cards) if (!used.has(card.id)) ordered.push(card);
  return ordered;
}

/**
 * 孩子走到过的题不再换：`locked` 是已经走到过的那几道，
 * 原样留着；后面的位置用新来的。草稿被拒后重调、两批先后颠倒、回合终态的权威结果和草稿不一样——
 * 这些都只会改到孩子还没看到的题，作答记录和结算里的错题都挂在他真看到的那道上。
 * `reached` = 孩子当前走到的下标 + 1（还没走到任何一道时为 0）。
 */
export function lockReached<T>(locked: readonly T[], incoming: readonly T[], reached: number): { shown: T[]; locked: T[] } {
  const shown = [...locked, ...incoming.slice(locked.length)];
  const keep = Math.max(locked.length, Math.min(reached, shown.length));
  return { shown, locked: keep === locked.length ? [...locked] : shown.slice(0, keep) };
}

// ---------------------------------------------------------------------------
// 判分
// ---------------------------------------------------------------------------

export type Answer =
  | { kind: "choice"; index: number }
  | { kind: "tiles"; picked: number[] }
  | { kind: "reading"; transcript: string; comparison: ReadingComparison };

/**
 * 本地判分（这是孩子每次点「检查」后零等待的原因）。
 * 拼句按**词序列**比，不按词块下标比：bank 里有两个 `a`、或者词块是 `would like` 这种
 * 多词块时，拼法不止一种，句子对就算对；大小写和句末标点不算错。
 * 跟读：逐词比对全绿才算对（不打发音分，见 `read-aloud.ts`）。
 */
export function grade(exercise: Exercise, answer: Answer): boolean {
  switch (exercise.type) {
    case "listen_choice":
    case "fill_blank":
      return answer.kind === "choice" && answer.index === exercise.answer_index;
    case "word_bank": {
      if (answer.kind !== "tiles") return false;
      const got = sentenceWords(answer.picked.map((i) => exercise.bank[i] ?? ""));
      const want = sentenceWords(exercise.answer);
      return got.length === want.length && got.every((word, i) => word === want[i]);
    }
    case "read_aloud":
      return answer.kind === "reading" && answer.comparison.total > 0 && answer.comparison.right === answer.comparison.total;
  }
}

/** 判定条上「正确答案」那一行。 */
export function correctText(exercise: Exercise): string {
  switch (exercise.type) {
    case "listen_choice":
      return exercise.options[exercise.answer_index];
    case "fill_blank":
      return exercise.sentence.replace("___", exercise.options[exercise.answer_index]);
    case "word_bank":
      return exercise.answer.join(" ");
    case "read_aloud":
      return exercise.text;
  }
}

/** 孩子的答案，原样写成一句（发给 agent 的【为什么】/【结算】里用）。 */
export function answerText(exercise: Exercise, answer: Answer): string {
  switch (answer.kind) {
    case "choice":
      return exercise.type === "listen_choice" || exercise.type === "fill_blank"
        ? (exercise.options[answer.index] ?? "")
        : "";
    case "tiles":
      return exercise.type === "word_bank" ? answer.picked.map((i) => exercise.bank[i] ?? "").join(" ") : "";
    case "reading":
      return answer.transcript;
  }
}

/** 一道题用一句话描述给 agent（题型 + 题面 + 正确答案）。 */
export function describeExercise(exercise: Exercise): string {
  switch (exercise.type) {
    case "listen_choice":
      return `听音选词：念的是「${exercise.audio_text}」，选项 ${exercise.options.join(" / ")}，正确答案是 ${correctText(exercise)}`;
    case "fill_blank":
      return `填空：「${exercise.sentence}」，选项 ${exercise.options.join(" / ")}，正确答案是 ${exercise.options[exercise.answer_index]}`;
    case "word_bank":
      return `拼句：题面「${exercise.prompt}」，正确答案是「${correctText(exercise)}」`;
    case "read_aloud":
      return `跟读：原句「${exercise.text}」`;
  }
}

// ---------------------------------------------------------------------------
// 发给 agent 的消息（格式写在 edu-english-coach 的 CLAUDE.md「怎么上这门课」里）
// ---------------------------------------------------------------------------

export interface LessonRequest {
  /** `english-path.ts` 的 `stopLabel`。 */
  label: string;
  goal: string;
  /** 页面给这一关起的编号，agent 原样抄进 present_lesson 的 lesson_id。 */
  lessonId: string;
}

/**
 * 【出题】W1：开一关（会话就绪就预先要，或者孩子点开了一个还没出好的关）。
 * 分两批出：整关一次出约 20–24 s，先出 2 道让孩子先答起来。
 * hint / explain 限长，第二批之后不再写字。
 */
export function lessonRequestMessage({ label, goal, lessonId }: LessonRequest): string {
  return [
    `【出题】${label}`,
    `lesson_id：${lessonId}`,
    `这一关要练：${goal}`,
    `分两批出：先调 present_lesson（lesson_id=${lessonId}，batch=1，batches=2）给前 2 道，再调 present_lesson（lesson_id=${lessonId}，batch=2，batches=2）给剩下 6 道。每道题的 hint 和 explain 各不超过 20 个汉字。第二批交出去这一轮就结束，正文留空，不要再写字。`,
  ].join("\n");
}

export interface Mistake {
  exercise: Exercise;
  /** 孩子第一次的答案（原样）。 */
  answer: string;
}

export interface SettlementInput {
  label: string;
  firstCorrect: number;
  scored: number;
  durationMs: number;
  mistakes: Mistake[];
  next: LessonRequest | null;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

/** 【结算】W4：这一关的成绩 + 错过的题 + 下一关，agent 回一句点评再出下一关。 */
export function settlementMessage(input: SettlementInput): string {
  const lines = [
    `【结算】${input.label}做完了：首次答对 ${input.firstCorrect} / ${input.scored}，用时 ${formatDuration(input.durationMs)}。`,
  ];
  if (input.mistakes.length === 0) {
    lines.push("错过的题：没有，全对。");
  } else {
    lines.push("错过的题：");
    input.mistakes.forEach((m, i) => {
      lines.push(`${i + 1}. ${describeExercise(m.exercise)}；孩子的答案「${m.answer || "（空）"}」`);
    });
  }
  if (input.next) {
    lines.push(`下一关：${input.next.label}，要练：${input.next.goal}`);
    lines.push(
      `先回一句中文点评，再调 present_lesson（lesson_id=${input.next.lessonId}，batch=1，batches=1）把下一关的 8 道一批出齐，下一关要专门练到上面错过的点。每道题的 hint 和 explain 各不超过 20 个汉字。调完这一轮就结束，不要再写字。`,
    );
  } else {
    lines.push("这是最后一关，只回一句中文点评，不用出下一关。");
  }
  return lines.join("\n");
}

/**
 * 结算点评框里显示的那一段：回合正文的**第一段**。【结算】要的是「一句点评 + 调工具」，模型有时
 * 在调完工具后再补一段（「下一关出好了」这类），那一段不进点评框。
 * 服务端按 text part 用空行拼正文（`turn-parts.ts` 的 `renderTurn`），第一段就是工具调用之前写的那段。
 */
export function reviewText(replyText: string | undefined): string {
  return (replyText ?? "").split(/\n\s*\n/).map((part) => part.trim()).find(Boolean) ?? "";
}

/** 【为什么】W2：孩子答错后要讲解。 */
export function whyMessage(exercise: Exercise, answer: string, position: number): string {
  return `【为什么】第 ${position} 题，${describeExercise(exercise)}。孩子的答案是「${answer || "（空）"}」。用一两句中文讲为什么，不调工具、不出新题。`;
}
