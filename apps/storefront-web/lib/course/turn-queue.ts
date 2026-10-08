/**
 * 英语小课的回合队列：一个会话同一时刻只能跑一个 agent 回合（平台对在飞时再派发回
 * `SESSION_TURN_IN_PROGRESS`），而页面想找 agent 的事不止一件——预出下一关、讲解、
 * 跟读点评、结算点评。这里只决定**下一个跑谁、哪些丢掉**，纯函数，不碰 React。
 *
 * 规则（阈值是本文件定的）：
 * 1. 孩子点过的（`urgent`）排最前，按点的先后。跟读是孩子按住说完的，入队就是 urgent。
 *    **不抢在飞的那一个**：中止回合要 `runs:abort` scope，站点 token 没有；在飞的跑完
 *    就轮到它。
 * 2. 没点过的后台请求：讲解在前，出下一关（结算点评 + 下一关、预出一关）在后——「关末
 *    生成下一关排在本关讲解之后」。同级按入队先后。
 * 3. 丢弃：还没开始的后台讲解，对应的题之后孩子又往前走了 `EXPLAIN_STALE_STEPS` 步及以上
 *    （默认 2），就丢掉——它已经没地方显示了。在飞的不丢（也停不下来），出关/点评不丢。
 *    「步」是页面推进的计数：每点一次「继续」+1；离开一关（结算或中途退出）一次 +2，
 *    那一关里没开始的讲解随之全部作废。重出（再练一次）的题会**再入队一次新的讲解**，
 *    不复用已丢掉的那条。
 */

export type JobKind = "lesson" | "review" | "explain" | "voice";

export interface QueuedJob {
  id: string;
  kind: JobKind;
  /** 入队时页面的步数（见文件头第 3 条）。 */
  step: number;
  /** 孩子点过了（或者本来就是孩子发起的）。 */
  urgent: boolean;
  /** 变成 urgent 的时刻；urgent 之间按它排。 */
  urgentAt: number;
  /** 入队序号；同级之间按它排。 */
  seq: number;
}

/** 后台讲解过了几步就丢。 */
export const EXPLAIN_STALE_STEPS = 2;

const RANK: Record<JobKind, number> = { voice: 0, explain: 1, review: 2, lesson: 2 };

export function isStale(job: QueuedJob, step: number): boolean {
  return job.kind === "explain" && !job.urgent && step - job.step >= EXPLAIN_STALE_STEPS;
}

function compare(a: QueuedJob, b: QueuedJob): number {
  if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
  if (a.urgent && b.urgent) return a.urgentAt - b.urgentAt || a.seq - b.seq;
  return RANK[a.kind] - RANK[b.kind] || a.seq - b.seq;
}

/** 从队里挑下一个：先把该丢的丢掉，再按规则排，取第一个。 */
export function takeNext<J extends QueuedJob>(
  queue: readonly J[],
  step: number,
): { next: J | null; rest: J[]; dropped: J[] } {
  const dropped = queue.filter((job) => isStale(job, step));
  const live = queue.filter((job) => !isStale(job, step)).sort(compare);
  const [next = null, ...rest] = live;
  return { next, rest, dropped };
}

/** 孩子点了某个还在排队的请求：把它提到 urgent（已经 urgent 的不动它的先后）。 */
export function promote<J extends QueuedJob>(queue: readonly J[], id: string, now: number): J[] {
  return queue.map((job) => (job.id === id && !job.urgent ? { ...job, urgent: true, urgentAt: now } : job));
}

/** 孩子离开了那道题（点了「继续」）：它的讲解不再算点过，回到后台规则（可能被丢）。 */
export function demote<J extends QueuedJob>(queue: readonly J[], id: string): J[] {
  return queue.map((job) => (job.id === id && job.urgent && job.kind === "explain" ? { ...job, urgent: false } : job));
}
