/**
 * 「团队群」回放的引擎：给定剧本和时刻 `t`，算出这一帧该画什么。
 *
 * 纯函数，不碰 DOM、不记状态——暂停是停时钟，重播是 `t = 0`，跳幕是把 `t` 设成那一幕的起点，
 * 三者都不需要「撤销已经播过的东西」。:eyes: 有没有加上、进度状态在不在、Stop 和批准有没有被按下、
 * PR 的检查过了没有，全部由 `t` 推出来。
 */

import type { HumanId, ReplayScript, Step, Tap } from "./script";

/** 成员去点按钮：按下之前，触点移过去用的时间。 */
export const TAP_LEAD_MS = 800;
/** 按下之后，按压反馈留在画面上的时间；过了这段，进度状态才消失、确认卡才变成「已批准」。 */
export const TAP_PRESS_MS = 500;

export type TapPhase = "idle" | "approach" | "press";

export interface TapView {
  by: HumanId;
  phase: TapPhase;
}

type StepOf<K extends Step["kind"]> = Extract<Step, { kind: K }>;

export type Row =
  | { kind: "message"; step: StepOf<"message">; eyes: boolean; replies: number }
  | {
      kind: "bot";
      step: StepOf<"bot">;
      replies: number;
      /** PR 卡：检查过了没有。 */
      passed: boolean;
      /** 确认卡：去点批准的触点；批准之后是 null。 */
      tap: TapView | null;
      /** 确认卡：批准了没有。 */
      approved: boolean;
    }
  | { kind: "status"; step: StepOf<"status">; tap: TapView | null }
  | { kind: "note"; step: StepOf<"note">; decided: boolean };

export interface Frame {
  rows: Row[];
  typing: HumanId | null;
  /** 当前幕在 `script.acts` 里的下标。 */
  act: number;
  ended: boolean;
}

function tapPhase(t: number, tap: Tap): TapPhase {
  if (t < tap.at - TAP_LEAD_MS) return "idle";
  return t < tap.at ? "approach" : "press";
}

export function frameAt(script: ReplayScript, t: number): Frame {
  const rows: Row[] = [];
  let typing: HumanId | null = null;
  for (const step of script.steps) {
    if (step.kind === "typing") {
      if (t >= step.from && t < step.to) typing = step.who;
    } else if (step.kind === "status") {
      // 被 Stop 的回合：按下之后状态还留一小会儿（按压反馈），然后消失。
      const until = step.stop ? step.stop.at + TAP_PRESS_MS : step.to;
      if (t >= step.from && t < until) {
        rows.push({ kind: "status", step, tap: step.stop ? { by: step.stop.by, phase: tapPhase(t, step.stop) } : null });
      }
    } else if (t < step.at) {
      continue;
    } else if (step.kind === "message") {
      rows.push({ kind: "message", step, eyes: step.eyesAt !== undefined && t >= step.eyesAt, replies: 0 });
    } else if (step.kind === "note") {
      rows.push({ kind: "note", step, decided: step.decideAt === undefined || t >= step.decideAt });
    } else {
      const block = step.block;
      const approved = block?.kind === "confirm" && t >= block.tap.at + TAP_PRESS_MS;
      rows.push({
        kind: "bot",
        step,
        replies: 0,
        passed: block?.kind === "pr" && t >= block.passAt,
        tap: block?.kind === "confirm" && !approved ? { by: block.tap.by, phase: tapPhase(t, block.tap) } : null,
        approved,
      });
    }
  }
  // 根消息下面的「N 条回复」：只数线程里的消息，旁注和进度状态不算。
  for (const row of rows) {
    if ((row.kind !== "message" && row.kind !== "bot") || row.step.thread !== undefined) continue;
    const root = row.step.id;
    row.replies = rows.filter((r) => (r.kind === "message" || r.kind === "bot") && r.step.thread === root).length;
  }
  let act = 0;
  script.acts.forEach((a, i) => {
    if (t >= a.at) act = i;
  });
  return { rows, typing, act, ended: t >= script.end };
}

export type ActState = "done" | "active" | "idle";

/** 右栏时间线上第 `index` 幕的状态：演过了、正在演、还没到。播完以后每一幕都是演过了。 */
export function actStateOf(frame: Frame, index: number): ActState {
  if (frame.ended || index < frame.act) return "done";
  return index === frame.act ? "active" : "idle";
}

/** 第 `index` 幕演到了没有（演过或正在演）。能力卡据此点亮。 */
export function reachedAct(frame: Frame, index: number): boolean {
  return frame.ended || index <= frame.act;
}

/**
 * 时钟走一步。两帧之间最多算 `maxStepMs`：标签页切走再回来，回放接着播，不跳过一大段。走到 `end` 封顶。
 */
export function advanceClock(t: number, elapsedMs: number, end: number, maxStepMs: number): number {
  return Math.min(end, t + Math.min(elapsedMs, maxStepMs));
}

/** `m:ss`，播放条和四幕列表上的时刻。 */
export function clockOf(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
