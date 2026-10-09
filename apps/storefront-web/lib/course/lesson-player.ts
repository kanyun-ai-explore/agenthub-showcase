/**
 * 关卡播放器的状态机：一屏一题、检查、继续、错题在关末重出、连对横幅、结算数字。
 * 纯函数，不碰 React，也不碰 agent——这一层里的每一步都在本地完成，所以学员点
 * 「检查」「继续」都是零等待。
 *
 * 规则：
 * - 先按顺序做一遍；第一遍答错的题，排到这一关最后**再出一遍**（「再练一次」），
 *   每道最多重出一次——重出那次再错也往下走，判定条上有正确答案。
 * - 进度条数的是「已经过关」的题：答对了、或者重出那次做完了、或者跳过了。第一遍
 *   答错的题不推进度条，要等它重出那一次。
 * - 正确率只看**第一遍**：首次答对数 / 计分题数（跳过的跟读题不计分）。
 * - 连对：每次检查答对 +1，答错归零；正好到 3、5 时出一次横幅。
 * - 分批到的一关（冷启的那一关先出 2 道）：`more` 表示还有题没到。
 *   第一遍做完已到的题而后面的还没来，就停在 `waiting`（页面放占位），不进「再练一次」；
 *   新题到了用 `extend` 接在第一遍末尾、重出的题之前。确定不会再来了用 `settle` 收尾。
 */

export interface Attempt<A = unknown> {
  correct: boolean;
  answer: A;
}

export type PlayerStage = "answering" | "checked" | "waiting" | "done";

export interface PlayerState<A = unknown> {
  /** 已经到手的题数（分批时会变多）。 */
  total: number;
  /** 还有题在路上（分批出的一关，后面的批次还没到）。 */
  more: boolean;
  /** 出题顺序：题目下标。第一遍是 0..total-1，答错的题追加在后面。 */
  order: number[];
  /** 当前在 `order` 里的位置。 */
  pos: number;
  stage: PlayerStage;
  attempts: Attempt<A>[][];
  /** 跳过的跟读题（「现在说不了」）。 */
  skipped: boolean[];
  combo: number;
  bestCombo: number;
  /** 这一次检查正好到了连对 3 / 5：页面弹横幅用，下一次检查就清掉。 */
  milestone: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export const COMBO_MILESTONES = [3, 5] as const;

export function startPlayer<A>(total: number, now: number, more = false): PlayerState<A> {
  return {
    total,
    more,
    order: Array.from({ length: total }, (_, i) => i),
    pos: 0,
    stage: total > 0 ? "answering" : "done",
    attempts: Array.from({ length: total }, () => []),
    skipped: Array.from({ length: total }, () => false),
    combo: 0,
    bestCombo: 0,
    milestone: null,
    startedAt: now,
    finishedAt: total > 0 ? null : now,
  };
}

export function currentIndex(state: PlayerState<unknown>): number | null {
  return state.stage === "done" || state.stage === "waiting" ? null : (state.order[state.pos] ?? null);
}

/** 当前这一题是不是在「再练一次」那一段。 */
export function inRetry(state: PlayerState<unknown>): boolean {
  return state.pos >= state.total;
}

/** 检查：记一次作答，第一遍答错的题排到末尾重出。只在 `answering` 时有效。 */
export function check<A>(state: PlayerState<A>, correct: boolean, answer: A): PlayerState<A> {
  const index = currentIndex(state);
  if (index === null || state.stage !== "answering") return state;
  const attempts = state.attempts.map((list, i) => (i === index ? [...list, { correct, answer }] : list));
  const firstTry = state.attempts[index].length === 0;
  const combo = correct ? state.combo + 1 : 0;
  return {
    ...state,
    attempts,
    order: !correct && firstTry ? [...state.order, index] : state.order,
    stage: "checked",
    combo,
    bestCombo: Math.max(state.bestCombo, combo),
    milestone: correct && (COMBO_MILESTONES as readonly number[]).includes(combo) ? combo : null,
  };
}

/** 继续：进下一题；第一遍到手的题做完了而后面还有题在路上，就等着；都做完了就结束。 */
export function advance<A>(state: PlayerState<A>, now: number): PlayerState<A> {
  if (state.stage === "done" || state.stage === "waiting") return state;
  const pos = state.pos + 1;
  if (state.more && pos >= state.total) {
    return { ...state, pos, stage: "waiting", milestone: null };
  }
  if (pos >= state.order.length) {
    return { ...state, pos, stage: "done", milestone: null, finishedAt: now };
  }
  return { ...state, pos, stage: "answering", milestone: null };
}

/**
 * 后面的批次到了：新题接在第一遍末尾、已经排上的重出题之前。在等的话接着答。
 * `total` 只增不减（同一关的批次拼起来只会更长）。
 */
export function extend<A>(state: PlayerState<A>, total: number, more: boolean, now: number): PlayerState<A> {
  if (total <= state.total) return more === state.more ? state : settle({ ...state }, now, more);
  const added = Array.from({ length: total - state.total }, (_, i) => state.total + i);
  const firstPass = state.order.slice(0, state.total);
  const retries = state.order.slice(state.total);
  const next: PlayerState<A> = {
    ...state,
    total,
    more,
    order: [...firstPass, ...added, ...retries],
    attempts: [...state.attempts, ...added.map(() => [])],
    skipped: [...state.skipped, ...added.map(() => false)],
  };
  return next.stage === "waiting" ? { ...next, stage: "answering" } : next;
}

/** 后面的批次确定不会来了（回合结束、只出了一批）：在等的话直接进「再练一次」或结束。 */
export function settle<A>(state: PlayerState<A>, now: number, more = false): PlayerState<A> {
  const next = { ...state, more };
  if (next.stage !== "waiting" || more) return next;
  if (next.pos < next.order.length) return { ...next, stage: "answering" };
  return { ...next, stage: "done", finishedAt: now };
}

/**
 * 手上的题变少了（防御：上游本该不缩短，见 english-lesson.ts 的 `settleLessonContent`）。
 * 超出的题从出题顺序里拿掉；当前这道没了就往下走，走完就结束——不让播放器停在一个越界的
 * 下标上画空白。
 */
export function truncate<A>(state: PlayerState<A>, total: number, now: number): PlayerState<A> {
  if (total >= state.total) return state;
  const keptBefore = state.order.slice(0, state.pos).filter((i) => i < total).length;
  const currentKept = (state.order[state.pos] ?? total) < total;
  const order = state.order.filter((i) => i < total);
  const next: PlayerState<A> = {
    ...state,
    total,
    more: false,
    order,
    pos: keptBefore,
    attempts: state.attempts.slice(0, total),
    skipped: state.skipped.slice(0, total),
  };
  if (next.pos >= order.length) return { ...next, stage: "done", milestone: null, finishedAt: now };
  // 在等后面的批次（more 已经收掉了）或者当前这道被拿掉了：接着答下一道。
  if (state.stage === "waiting" || !currentKept) return { ...next, stage: "answering", milestone: null };
  return next;
}

/**
 * 跳过当前这道（只给跟读题用：没有麦克风、或者学员这会儿说不了）。不计分、不重出、
 * 不打断连对，直接进下一题。
 */
export function skip<A>(state: PlayerState<A>, now: number): PlayerState<A> {
  const index = currentIndex(state);
  if (index === null) return state;
  const skipped = state.skipped.map((value, i) => (i === index ? true : value));
  // 这道题如果第一遍答错过、已经排了重出，把排在后面的那一次也撤掉。
  const order = state.order.filter((value, i) => i <= state.pos || value !== index);
  return advance({ ...state, skipped, order, stage: "checked" }, now);
}

/** 这道题过关了没有（进度条按它数）。 */
export function resolved(state: PlayerState<unknown>, index: number): boolean {
  if (state.skipped[index]) return true;
  const list = state.attempts[index];
  if (list.length === 0) return false;
  return list[list.length - 1].correct || list.length >= 2;
}

/** 进度条。还有批次在路上时按 `expected`（一关的题数，8）当分母，免得第一批 2 道一做完就满格。 */
export function progressRatio(state: PlayerState<unknown>, expected = 0): number {
  const denominator = state.more ? Math.max(state.total, expected) : state.total;
  if (denominator === 0) return 1;
  let done = 0;
  for (let i = 0; i < state.total; i += 1) if (resolved(state, i)) done += 1;
  return done / denominator;
}

export interface PlayerSummary<A> {
  /** 首次就答对的题数。 */
  firstCorrect: number;
  /** 计分的题数（跳过的不算）。 */
  scored: number;
  /** 0–1；没有计分题时为 1。 */
  accuracy: number;
  durationMs: number;
  bestCombo: number;
  /** 第一遍答错的题：下标 + 那一次的答案（发给 agent 出下一关用）。 */
  mistakes: { index: number; answer: A }[];
}

export function summarize<A>(state: PlayerState<A>): PlayerSummary<A> {
  let firstCorrect = 0;
  let scored = 0;
  const mistakes: { index: number; answer: A }[] = [];
  state.attempts.forEach((list, index) => {
    if (state.skipped[index] && list.length === 0) return;
    if (list.length === 0) return;
    scored += 1;
    if (list[0].correct) firstCorrect += 1;
    else mistakes.push({ index, answer: list[0].answer });
  });
  return {
    firstCorrect,
    scored,
    accuracy: scored === 0 ? 1 : firstCorrect / scored,
    durationMs: (state.finishedAt ?? state.startedAt) - state.startedAt,
    bestCombo: state.bestCombo,
    mistakes,
  };
}
