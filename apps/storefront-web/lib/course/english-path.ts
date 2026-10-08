/**
 * 英语小课的路径图：单元 → 关卡，写死在前端。
 *
 * 关卡里**没有题**——题由 agent 在开关时用 `present_lesson` 现出（W1）。这里只定「这一关
 * 练什么」：`goal` 原样写进发给 agent 的【出题】/【结算】消息，所以措辞要落在
 * edu-english-coach 的 CLAUDE.md「教学范围」以内（打招呼、饮品、颜色、数字 1–10、
 * I like / I would like / This is / It is、礼貌用语），超纲的 agent 会如实说没教到。
 *
 * `id` 是进度存档里的键（`lib/showcase/progress.ts` 的 `completed`），**改 id 等于清掉
 * 已有访客那一关的通关记录**；改标题、改 goal 不影响存档。
 */

export interface PathLevel {
  id: string;
  title: string;
  /** 这一关要练什么，一句中文，原样发给 agent。 */
  goal: string;
}

export interface PathUnit {
  id: string;
  title: string;
  emoji: string;
  levels: PathLevel[];
}

export const UNITS: PathUnit[] = [
  {
    id: "u1",
    title: "打招呼",
    emoji: "👋",
    levels: [
      { id: "u1-l1", title: "Hello 和 Goodbye", goal: "见面和告别：Hello / Hi / Goodbye / Bye" },
      { id: "u1-l2", title: "介绍自己", goal: "用 I am … 和 My name is … 介绍自己" },
      { id: "u1-l3", title: "礼貌用语", goal: "please / thank you / sorry 什么时候说" },
      { id: "u1-l4", title: "单元复习", goal: "复习打招呼、介绍自己和礼貌用语" },
    ],
  },
  {
    id: "u2",
    title: "点咖啡",
    emoji: "☕",
    levels: [
      { id: "u2-l1", title: "饮品", goal: "认识 coffee / tea / milk，听得出、选得对" },
      { id: "u2-l2", title: "I like …", goal: "用 I like … 说喜欢的饮品和 cake" },
      { id: "u2-l3", title: "I would like …", goal: "用 I would like a … please 点一杯饮品" },
      { id: "u2-l4", title: "单元复习", goal: "复习饮品词、I like 和 I would like" },
    ],
  },
  {
    id: "u3",
    title: "颜色和数字",
    emoji: "🎨",
    levels: [
      { id: "u3-l1", title: "颜色", goal: "认识 red / blue / green" },
      { id: "u3-l2", title: "数字 1–5", goal: "认识 one 到 five" },
      { id: "u3-l3", title: "数字 6–10", goal: "认识 six 到 ten" },
      { id: "u3-l4", title: "This is / It is", goal: "用 This is … 和 It is … 说颜色和数量" },
    ],
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

/** 这一关之后的那一关；最后一关返回 null。 */
export function nextStop(levelId: string): PathStop | null {
  const stop = stopById(levelId);
  if (!stop) return null;
  return PATH[stop.index + 1] ?? null;
}

/**
 * 第一个还没通关的关卡（路径图上那个亮着的「开始」）。全部通关后停在最后一关，可以重玩。
 */
export function currentStop(completed: readonly string[]): PathStop {
  const done = new Set(completed);
  return PATH.find((stop) => !done.has(stop.level.id)) ?? PATH[PATH.length - 1];
}

/** 解锁规则：通关过的、或者它前一关通关了的（第一关永远解锁）。 */
export function isUnlocked(levelId: string, completed: readonly string[]): boolean {
  const stop = stopById(levelId);
  if (!stop) return false;
  if (stop.index === 0 || completed.includes(levelId)) return true;
  return completed.includes(PATH[stop.index - 1].level.id);
}

/** 「第 1 单元「打招呼」· 第 2 关「介绍自己」」——发给 agent 的消息里统一这么称呼一关。 */
export function stopLabel(stop: PathStop): string {
  const unitNo = UNITS.indexOf(stop.unit) + 1;
  const levelNo = stop.unit.levels.indexOf(stop.level) + 1;
  return `第 ${unitNo} 单元「${stop.unit.title}」· 第 ${levelNo} 关「${stop.level.title}」`;
}
