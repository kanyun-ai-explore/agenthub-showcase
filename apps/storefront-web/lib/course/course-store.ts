"use client";

/**
 * 课程 v2 在本机存的东西：错题、每关成绩、单元 3 生成好的关、单元 3 哪几关已经打开过。
 *
 * 为什么要存：一门课做下来几十分钟，中途刷新页面很常见。单元 3 要「带上到目前为止的错题」出，
 * 还要在单元 2 做完时已经出好——只放在内存里，刷新一次错题就没了，出好的单元 3 也没了，
 * 学员做完单元 2 看到的会是「正在生成」，而且是按「没有错题」出的。
 *
 * 和 `lib/showcase/progress.ts` 同一套纪律：按访客 id 分键，访客 id 还没拿到时读写都空转；
 * 所有 localStorage 读写包 try/catch（隐私模式会抛），记不住也不让整页报错。进度（XP、连胜、
 * 通关）仍归 progress.ts，这里不重复存。
 *
 * 本文件只做存取和纯粹的状态变换；单元 3 的题读回来以后由调用方再过一遍 `lessonFromCards`
 * （本机存的东西也当外部输入看）。lib/course 下的模块互不做值导入，所以这里只引类型。
 */

import type { Exercise, LessonContent, LessonResult, Mistake } from "./english-lesson";

export const COURSE_KEY_PREFIX = "agenthub-showcase-english-course-v2";

/** 错题最多留多少条：【出题】只用最近 12 道，单元结算只看本单元的，60 条足够。 */
export const MISTAKE_LOG_LIMIT = 60;

export interface MistakeRecord {
  levelId: string;
  /** 错在哪一关（`stopLabel`）。 */
  where: string;
  exercise: Exercise;
  answer: string;
  at: number;
}

export interface CourseState {
  /** 错题，旧的在前。 */
  mistakes: MistakeRecord[];
  /** 每关最近一次的成绩（单元结算用）。 */
  results: Record<string, LessonResult>;
  /** 单元 3 生成好的关：levelId → 这一关的题。 */
  unit3: Record<string, LessonContent>;
  /** 单元 3 打开过的关：levelId → 打开的那一版的页面编号（lessonId）。打开过的不再重出。 */
  opened: Record<string, string>;
}

/** 空的课程状态。每次都给一份新的（调用方会改它的副本，不能共用一个对象）。 */
function emptyCourse(): CourseState {
  return { mistakes: [], results: {}, unit3: {}, opened: {} };
}

function keyFor(visitorId: string): string {
  return `${COURSE_KEY_PREFIX}:${visitorId}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 读回来的东西只做形状上的粗筛：每一项的题，调用方还会再过一遍 `lessonFromCards`。 */
export function coerceCourse(raw: unknown): CourseState {
  if (!isRecord(raw)) return emptyCourse();
  const mistakes = Array.isArray(raw.mistakes)
    ? raw.mistakes.filter(
        (m): m is MistakeRecord =>
          isRecord(m) && typeof m.levelId === "string" && typeof m.where === "string" && isRecord(m.exercise) && typeof m.answer === "string",
      )
    : [];
  const results: Record<string, LessonResult> = {};
  if (isRecord(raw.results)) {
    for (const [id, r] of Object.entries(raw.results)) {
      if (isRecord(r) && typeof r.label === "string" && typeof r.firstCorrect === "number" && typeof r.scored === "number") {
        results[id] = { label: r.label, firstCorrect: r.firstCorrect, scored: r.scored };
      }
    }
  }
  const unit3: Record<string, LessonContent> = {};
  if (isRecord(raw.unit3)) {
    for (const [id, c] of Object.entries(raw.unit3)) {
      if (isRecord(c) && Array.isArray(c.exercises) && typeof c.lessonId === "string") unit3[id] = c as unknown as LessonContent;
    }
  }
  const opened: Record<string, string> = {};
  if (isRecord(raw.opened)) {
    for (const [id, lessonId] of Object.entries(raw.opened)) if (typeof lessonId === "string") opened[id] = lessonId;
  }
  return { mistakes: mistakes.slice(-MISTAKE_LOG_LIMIT), results, unit3, opened };
}

export function readCourse(visitorId: string | null): CourseState {
  if (!visitorId || typeof window === "undefined") return emptyCourse();
  try {
    const raw = window.localStorage.getItem(keyFor(visitorId));
    return raw ? coerceCourse(JSON.parse(raw)) : emptyCourse();
  } catch {
    return emptyCourse();
  }
}

export function writeCourse(visitorId: string | null, state: CourseState): void {
  if (!visitorId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyFor(visitorId), JSON.stringify(state));
  } catch {
    // 隐私模式 / 存满了：这次记不住，页面照常
  }
}

/** 做完一关：记成绩，把这一关第一遍错的题追加进错题（超出上限丢最旧的）。 */
export function recordLesson(
  state: CourseState,
  input: { levelId: string; result: LessonResult; mistakes: Mistake[]; at: number },
): CourseState {
  const added: MistakeRecord[] = input.mistakes.map((m) => ({
    levelId: input.levelId,
    where: m.where ?? input.result.label,
    exercise: m.exercise,
    answer: m.answer,
    at: input.at,
  }));
  return {
    ...state,
    results: { ...state.results, [input.levelId]: input.result },
    mistakes: [...state.mistakes, ...added].slice(-MISTAKE_LOG_LIMIT),
  };
}

/** 最近的错题，最近的在前；同一道题错过几次只留最近那次（按题面描述认「同一道」）。 */
export function recentMistakes(state: CourseState, limit: number, filter?: (m: MistakeRecord) => boolean): Mistake[] {
  const seen = new Set<string>();
  const out: Mistake[] = [];
  for (let i = state.mistakes.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const m = state.mistakes[i];
    if (filter && !filter(m)) continue;
    const key = `${m.exercise.type}:${JSON.stringify(m.exercise)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ exercise: m.exercise, answer: m.answer, where: m.where });
  }
  return out;
}

/**
 * 单元 3 的这一关还能不能重出：做完了、或者打开过而且那一版已经存下了，就不能。打开过却没存下
 * （打开的是还在生成的那一版，后来没出成）的可以重出，不然这一关就永远空着。
 */
export function canRegenerate(state: CourseState, levelId: string, completed: readonly string[]): boolean {
  if (completed.includes(levelId)) return false;
  return !(levelId in state.opened && levelId in state.unit3);
}

/**
 * 生成好的一关能不能存进 `unit3`：没打开过的都能（新的一版盖掉旧的）；打开过的只认打开的那一版
 * （同一个 lessonId，分批到的后面几批、回合终态的权威结果）——学员手上那一关不被换掉。打开过
 * 却什么都没存下的（见 `canRegenerate`）照常收。
 */
export function acceptGenerated(state: CourseState, levelId: string, content: LessonContent): boolean {
  const openedAs = state.opened[levelId];
  return openedAs === undefined || openedAs === content.lessonId || !(levelId in state.unit3);
}

export function saveGenerated(state: CourseState, levelId: string, content: LessonContent): CourseState {
  return { ...state, unit3: { ...state.unit3, [levelId]: content } };
}

export function markOpened(state: CourseState, levelId: string, lessonId: string): CourseState {
  return { ...state, opened: { ...state.opened, [levelId]: lessonId } };
}
