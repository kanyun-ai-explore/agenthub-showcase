"use client";

/**
 * 英语小课的进度：XP、连胜天数、路径图上通关了哪几关、最长连对，只存 localStorage
 * （先不做进度后端，定位是 agent 能力的 showcase，不是完整应用）。不加 MCP
 * 工具、不建后端。
 *
 * 键按**访客 id** 分（`lib/showcase/visitor.ts` 那一个），所以「换个人」就是换一把键：
 * 新访客从 0 开始，老访客回来接着上一次的数。访客 id 还没拿到（会话建好之前）时
 * 读写都退化成空转，不会写进一把没有身份的键里。
 *
 * 所有 localStorage 读写都包 try/catch：隐私模式下读写都会抛，抛的时候这一课照样上完，
 * 只是记不住——记不住比整页报错好。这里没有读改写竞争要防：一份进度只属于一个浏览器。
 *
 * **键和旧字段不变**（一期、二期写下的存档照常读）：路径图改版只**加**了 `completed`
 * 和 `bestCombo` 两个字段。旧存档没有 `completed`，按它的 `lessons`（上完几节）把路径上
 * 前几关记成已通关——老访客回来不会被打回第一关。
 */

export interface CourseProgress {
  /** 累计 XP。 */
  xp: number;
  /** 连胜天数：连续每天上完一节课就 +1，断一天归 1。 */
  streak: number;
  /** 连胜最后一次变化的日历日（**本机时区**，连胜的口径是「今天打卡了没」，
   *  用 UTC 会让晚上 8 点之后的课算到明天）。 */
  lastDay: string;
  /** 上完的课节数。 */
  lessons: number;
  /** 路径图上通关过的关卡 id（`lib/course/english-path.ts`），按第一次通关的先后。 */
  completed: string[];
  /** 历史最长连对（一关之内连续答对的题数）。 */
  bestCombo: number;
}

/** 一节课的 XP。前端定一个常数，不放在 agent 那侧——它只是本机的一个数字。 */
export const XP_PER_LESSON = 15;

export const PROGRESS_KEY_PREFIX = "agenthub-showcase-english-progress";

const EMPTY: CourseProgress = { xp: 0, streak: 0, lastDay: "", lessons: 0, completed: [], bestCombo: 0 };

/**
 * 路径上的关卡 id 按顺序排好。从 `english-path.ts` 注入而不是直接 import：这个文件要
 * 能被检查脚本单独加载，路径图那边改了顺序也只改那一处。
 */
let pathOrder: readonly string[] = [];
export function setPathOrder(ids: readonly string[]): void {
  pathOrder = ids;
}

function keyFor(visitorId: string): string {
  return `${PROGRESS_KEY_PREFIX}:${visitorId}`;
}

/** 本机时区的日历日，YYYY-MM-DD。 */
function dayOf(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 前一天的同一种表示。用日期差算，不用 `-86400000` 毫秒减——夏令时下那不是「昨天」。 */
function previousDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const at = new Date(y, (m ?? 1) - 1, d ?? 1);
  at.setDate(at.getDate() - 1);
  return dayOf(at);
}

function coerce(raw: unknown): CourseProgress {
  if (typeof raw !== "object" || raw === null) return { ...EMPTY, completed: [] };
  const value = raw as Partial<Record<keyof CourseProgress, unknown>>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const lessons = num(value.lessons);
  const completed = Array.isArray(value.completed)
    ? value.completed.filter((id): id is string => typeof id === "string")
    : // 旧存档（路径图之前写的）：上过几节，就把路径上前几关算作通关。
      pathOrder.slice(0, Math.min(lessons, pathOrder.length));
  return {
    xp: num(value.xp),
    streak: num(value.streak),
    lastDay: typeof value.lastDay === "string" ? value.lastDay : "",
    lessons,
    completed,
    bestCombo: num(value.bestCombo),
  };
}

/** 读一份进度。读不到（没写过 / 隐私模式 / 存的是别的形状）一律返回 0 起点。 */
export function readProgress(visitorId: string | null): CourseProgress {
  if (!visitorId || typeof window === "undefined") return { ...EMPTY, completed: [] };
  try {
    const raw = window.localStorage.getItem(keyFor(visitorId));
    if (!raw) return { ...EMPTY, completed: [] };
    return coerce(JSON.parse(raw));
  } catch {
    return { ...EMPTY, completed: [] };
  }
}

/**
 * 过完一关：记 XP、课节数 +1、这一关记成已通关（重玩不重复记）、更新最长连对，
 * 并按「今天」推进连胜。
 *
 * 连胜规则（三条）：今天已经上过 ⇒ 不变；昨天上过 ⇒ +1；
 * 更早或第一次 ⇒ 从 1 重新开始。`now` 可注入，方便算清楚这条规则本身。
 */
export function finishLesson(
  visitorId: string | null,
  result: { levelId: string; combo: number },
  now: Date = new Date(),
): CourseProgress {
  const before = readProgress(visitorId);
  const today = dayOf(now);
  const next: CourseProgress = {
    xp: before.xp + XP_PER_LESSON,
    lessons: before.lessons + 1,
    streak: before.lastDay === today ? Math.max(1, before.streak) : before.lastDay === previousDay(today) ? before.streak + 1 : 1,
    lastDay: today,
    completed: before.completed.includes(result.levelId) ? before.completed : [...before.completed, result.levelId],
    bestCombo: Math.max(before.bestCombo, result.combo),
  };
  if (visitorId) {
    try {
      window.localStorage.setItem(keyFor(visitorId), JSON.stringify(next));
    } catch {
      // 隐私模式：这一课的数留不下，返回值仍是这一次该显示的数
    }
  }
  return next;
}

/** 仅供测试/本地核验：把一条键抹掉（不动别的访客）。 */
export function clearProgress(visitorId: string): void {
  try {
    window.localStorage.removeItem(keyFor(visitorId));
  } catch {
    // 同上
  }
}

// ---------------------------------------------------------------------------
// 情景对话（三期）的计数：同样只存本机、同样按访客 id 分键
// ---------------------------------------------------------------------------

/**
 * 聊完的对话次数。**没有 XP、没有连胜**——三期的口径是「先不做进度」，只有
 * 一句「这是你这台设备上第几次」。所以它不挤进上面那套 XP/连胜的键：两门课的结算
 * 各记各的，改一边不会动另一边。
 */
export interface RoleplayProgress {
  conversations: number;
}

export const ROLEPLAY_KEY_PREFIX = "agenthub-showcase-roleplay-progress";

const EMPTY_ROLEPLAY: RoleplayProgress = { conversations: 0 };

/** 读一次情景对话的计数；读不到一律 0 起点（同 `readProgress` 的口径）。 */
export function readRoleplay(visitorId: string | null): RoleplayProgress {
  if (!visitorId || typeof window === "undefined") return { ...EMPTY_ROLEPLAY };
  try {
    const raw = window.localStorage.getItem(`${ROLEPLAY_KEY_PREFIX}:${visitorId}`);
    if (!raw) return { ...EMPTY_ROLEPLAY };
    const value = JSON.parse(raw) as Partial<RoleplayProgress> | null;
    const count = typeof value?.conversations === "number" && Number.isFinite(value.conversations) && value.conversations >= 0
      ? Math.floor(value.conversations)
      : 0;
    return { conversations: count };
  } catch {
    return { ...EMPTY_ROLEPLAY };
  }
}

/** 聊完一次：计数 +1 并写回。写不进去（隐私模式）也照样返回这次该显示的数。 */
export function finishRoleplay(visitorId: string | null): RoleplayProgress {
  const next: RoleplayProgress = { conversations: readRoleplay(visitorId).conversations + 1 };
  if (visitorId) {
    try {
      window.localStorage.setItem(`${ROLEPLAY_KEY_PREFIX}:${visitorId}`, JSON.stringify(next));
    } catch {
      // 隐私模式：这一次数留不下，返回值仍是这一次该显示的数
    }
  }
  return next;
}
