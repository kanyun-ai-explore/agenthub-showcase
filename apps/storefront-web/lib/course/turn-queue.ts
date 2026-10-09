/**
 * 英语小课的回合队列：一个会话同一时刻只能跑一个 agent 回合（平台对在飞时再派发回
 * `SESSION_TURN_IN_PROGRESS`），而页面想找 agent 的事不止一件——后台出单元 3 的一关、讲解、
 * 跟读点评、单元点评（课程 v2）。这里只决定**下一个跑谁、哪些丢掉**，纯函数，不碰 React。
 *
 * 规则（阈值是本文件定的）：
 * 1. 学员点过的（`urgent`）排最前，按点的先后。跟读是学员按住说完的，入队就是 urgent。
 *    **不抢在飞的那一个**：中止回合要 `runs:abort` scope，站点 token 没有；在飞的跑完
 *    就轮到它。
 * 2. 没点过的后台请求：讲解在前，出单元 3 的一关和单元点评在后——学员正在看的讲解先跑，
 *    背后的出题再慢也不挡它。同级按入队先后（单元末关先排点评、再排出题）。
 * 3. 丢弃：还没开始的后台讲解，对应的题之后学员又往前走了 `EXPLAIN_STALE_STEPS` 步及以上
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
  /** 学员点过了（或者本来就是学员发起的）。 */
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

/** 学员点了某个还在排队的请求：把它提到 urgent（已经 urgent 的不动它的先后）。 */
export function promote<J extends QueuedJob>(queue: readonly J[], id: string, now: number): J[] {
  return queue.map((job) => (job.id === id && !job.urgent ? { ...job, urgent: true, urgentAt: now } : job));
}

/** 学员离开了那道题（点了「继续」）：它的讲解不再算点过，回到后台规则（可能被丢）。 */
export function demote<J extends QueuedJob>(queue: readonly J[], id: string): J[] {
  return queue.map((job) => (job.id === id && job.urgent && job.kind === "explain" ? { ...job, urgent: false } : job));
}

/**
 * 学员跳过了一道跟读：这道题还没发出去的那次录音不发了（已经在发的停不下来，结果回来时题已经换了，
 * 页面不会再用它）。
 */
export function dropVoice<J extends QueuedJob & { key?: string }>(queue: readonly J[], key: string): J[] {
  return queue.filter((job) => !(job.kind === "voice" && job.key === key));
}

/**
 * 会话没起来（最后变成 error / unconfigured）：排着的活一件都不会再跑了（pump 只在会话就绪时跑），
 * 全部交出来由页面收尾——不然跟读会一直显示「排队中」，讲解一直转圈。
 * 静态关在会话就绪之前就能做到跟读题，这种情况演示里撞上的机会变多了。
 */
export function drainQueue<J extends QueuedJob>(
  queue: readonly J[],
  shouldDrain: (job: J) => boolean = () => true,
): { rest: J[]; drained: J[] } {
  // 只收尾跑不了的那些：两条道时，第二个会话还能用，它那条道上的出题活留着等它。
  return { rest: queue.filter((job) => !shouldDrain(job)), drained: queue.filter(shouldDrain) };
}

/** 一件活在哪个会话上跑。 */
export type Lane = "main" | "background";

/**
 * 单元 3 的后台出题走第二个会话（能用的时候），讲解、跟读、单元点评都留在主会话——刚做完一关时，
 * 学员点「为什么」、做跟读不必排在 30 s 的出题回合后面（实测读数）。
 * 第二个会话起不来或者中途出错（`backgroundUsable` 为 false）就整体回落到主会话，和改之前一样排队。
 */
export function laneOf(job: { kind: JobKind }, backgroundUsable: boolean): Lane {
  return job.kind === "lesson" && backgroundUsable ? "background" : "main";
}

/**
 * 第二个会话上的出题回合没跑完（不是 `completed`、也不是「会话正在恢复」或「正在换新会话」）：说明这个会话坏了。就绪以后
 * 沙箱坏掉、被终止、等终态超时，phase 都还停在 ready，只看 phase 回落不了；这一关的重出会一直派回坏掉的
 * 会话，单元 3 卡在失败循环里。这时把第二个会话记成不可用，这件活改走主会话。
 * 回合跑完了、只是题出得不合格（缺听音 / 跟读），是模型的事，不算会话坏了，照常在原来的会话上重出。
 */
export function abandonsBackground(lane: Lane, outcome: { ok: boolean; code?: string }): boolean {
  return lane === "background" && !outcome.ok && outcome.code !== "SESSION_REVIVING" && outcome.code !== "SESSION_REBUILDING";
}
