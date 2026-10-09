/**
 * 英语小课的路径图：单元 → 关卡（课程 v2）。
 *
 * - 单元 1、2 是**静态**的：题写死在 `units/u1.json`、`units/u2.json`，所有学员一样，做题不等 agent。
 *   关卡标题和「这一关练什么」直接取自那两个文件（`title`、`focus`），这里不再抄一份。
 * - 单元 3 **课中生成**：五关的题由 agent 照学员在单元 1、2 错过的点现出（出哪一关由本文件的
 *   `generationTarget` 定，`EnglishCourseApp` 的 `finish` 在每关做完时调它），单元 2 做完才解锁。
 *
 * 关卡 id 是进度存档的键（`lib/showcase/progress.ts` 的 `completed`）。**课程 v2 统一加前缀 `b1-`**
 * （`b1-u1-l1` … `b1-u3-l5`）：旧路径（一年级启蒙，`u1-l1` … `u3-l4`）的 id 和 JSON 里的 lesson_id
 * 同形，不加前缀的话，老访客做过的「Hello 和 Goodbye」会让新的「计划一次旅行」显示成已通关。
 * JSON 里的 `lesson_id` 保持 `u1-l1` 不动（`scripts/course-units/check.mjs` 按它核结构），页面编号
 * 由 `staticLesson` 盖成带前缀的 id。
 */

import u1 from "./units/u1.json" with { type: "json" };
import u2 from "./units/u2.json" with { type: "json" };

/** 课程 v2 的关卡 id 前缀（见文件头）。 */
export const LEVEL_PREFIX = "b1-";

export interface PathLevel {
  id: string;
  title: string;
  /** 这一关练什么，一句中文：静态关取 JSON 的 `focus`；单元 3 原样写进发给 agent 的【出题】。 */
  goal: string;
}

export interface PathUnit {
  id: string;
  title: string;
  emoji: string;
  /** `static` = 题写死在 JSON 里；`generated` = 课中由 agent 生成（单元 3）。 */
  kind: "static" | "generated";
  levels: PathLevel[];
}

interface UnitFile {
  id: string;
  title: string;
  levels: { lesson_id: string; title: string; focus: string; exercises: unknown[] }[];
}

const STATIC_FILES: { file: UnitFile; emoji: string }[] = [
  { file: u1 as UnitFile, emoji: "✈️" },
  { file: u2 as UnitFile, emoji: "💼" },
];

/** 单元 3 的关数，和静态单元一样是 5 关：单元 1、2 的第 k 关做完，就出（或重出）单元 3 的第 k 关。 */
export const GENERATED_LEVELS = 5;

export const UNITS: PathUnit[] = [
  ...STATIC_FILES.map(({ file, emoji }) => ({
    id: `${LEVEL_PREFIX}${file.id}`,
    title: file.title,
    emoji,
    kind: "static" as const,
    levels: file.levels.map((level) => ({
      id: `${LEVEL_PREFIX}${level.lesson_id}`,
      title: level.title,
      goal: level.focus,
    })),
  })),
  {
    id: `${LEVEL_PREFIX}u3`,
    title: "按你的错题加练",
    emoji: "🎯",
    kind: "generated",
    levels: Array.from({ length: GENERATED_LEVELS }, (_, i) => ({
      id: `${LEVEL_PREFIX}u3-l${i + 1}`,
      title: `错题加练 ${i + 1}`,
      goal: "照你在单元 1、2 错过的点出题，换个说法、换个题型再考一次",
    })),
  },
];

/** 按顺序摊平的全部关卡，带上所属单元，解锁和「下一关」都按这个顺序算。 */
export interface PathStop {
  unit: PathUnit;
  level: PathLevel;
  /** 在整条路径上的序号，从 0 开始。 */
  index: number;
}

export const PATH: PathStop[] = UNITS.flatMap((unit) => unit.levels.map((level) => ({ unit, level }))).map(
  (stop, index) => ({ ...stop, index }),
);

export function stopById(levelId: string): PathStop | undefined {
  return PATH.find((stop) => stop.level.id === levelId);
}

/**
 * 第一个还没通关的关卡（路径图上那个亮着的「开始」）。全部通关后停在最后一关，可以重玩。
 * 不认识的 id（旧路径留下的 `u1-l1` 这类）不算通关。
 */
export function currentStop(completed: readonly string[]): PathStop {
  const done = new Set(completed);
  return PATH.find((stop) => !done.has(stop.level.id)) ?? PATH[PATH.length - 1];
}

/**
 * 解锁规则：通关过的、或者它前一关通关了的（第一关永远解锁）。单元 3 第 1 关的前一关是单元 2
 * 第 5 关，所以「单元 3 在单元 2 做完后才解锁」就是这条规则本身。
 */
export function isUnlocked(levelId: string, completed: readonly string[]): boolean {
  const stop = stopById(levelId);
  if (!stop) return false;
  if (stop.index === 0 || completed.includes(levelId)) return true;
  return completed.includes(PATH[stop.index - 1].level.id);
}

/** 一个单元的最后一关：做完它就是单元结算（agent 写一句单元点评）。 */
export function isUnitEnd(stop: PathStop): boolean {
  return stop.unit.levels[stop.unit.levels.length - 1]?.id === stop.level.id;
}

/** 「第 1 单元「出门旅行」· 第 2 关「在机场」」——发给 agent 的消息里统一这么称呼一关。 */
export function stopLabel(stop: PathStop): string {
  const unitNo = UNITS.indexOf(stop.unit) + 1;
  const levelNo = stop.unit.levels.indexOf(stop.level) + 1;
  return `第 ${unitNo} 单元「${stop.unit.title}」· 第 ${levelNo} 关「${stop.level.title}」`;
}

/** 「第 1 单元「出门旅行」」 */
export function unitLabel(unit: PathUnit): string {
  return `第 ${UNITS.indexOf(unit) + 1} 单元「${unit.title}」`;
}

/**
 * 静态关在 JSON 里的那一关（一次 `present_lesson` 的入参形状）。单元 3 和不认识的 id 返回 null。
 * 转成题由调用方做：当成一张 `lesson` 卡交给 `lessonFromCards`，走和 agent 出的题同一条取题链路
 * （`scripts/course-units/check.mjs` 逐关核过这条链路 `dropped` = 0），再盖上带前缀的页面编号。
 * 这里不直接 import english-lesson：lib/course 下的模块互不做值导入，检查脚本才能单独加载每一个。
 */
export function staticLevelPayload(levelId: string): UnitFile["levels"][number] | null {
  for (const { file } of STATIC_FILES) {
    const level = file.levels.find((l) => `${LEVEL_PREFIX}${l.lesson_id}` === levelId);
    if (level) return level;
  }
  return null;
}

/**
 * 单元 3 的出题时刻：**单元 1 或单元 2 的第 k 关做完 → 后台出
 * 单元 3 的第 k 关**，带上到这一刻为止的错题。
 * - 单元 1 第 1 关做完就出单元 3 第 1 关，之后每做完一关出下一关；
 * - 单元 1 的五关做完时单元 3 的五关都有了一版；单元 2 的第 k 关做完，再用最新的错题重出第 k 关——
 *   这样单元 2 的错题也进得了单元 3，而单元 3 第 k 关最晚在单元 2 第 k 关做完时开始重出，
 *   比学员能打开它早得多（要先做完单元 2 的其余几关和单元 3 的前 k−1 关）。
 * 学员打开过或做完的那一关不再重出（调用方判，见 `course-store.ts` 的 `canRegenerate`）。
 * 返回要出的那一关的 id；单元 3 本身和不认识的 id 返回 null。
 */
export function generationTarget(levelId: string): string | null {
  const stop = stopById(levelId);
  if (!stop || stop.unit.kind !== "static") return null;
  const k = stop.unit.levels.indexOf(stop.level);
  const generated = UNITS.find((unit) => unit.kind === "generated");
  return generated?.levels[k]?.id ?? null;
}
