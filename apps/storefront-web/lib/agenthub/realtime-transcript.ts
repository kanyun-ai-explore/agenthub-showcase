/**
 * 实时通话的转写：把 SDK `onTranscript` 的帧折成「一轮一句话」的对话稿。
 *
 * 帧是增量，不是全文：同一轮里每个角色的 `text` 要按 `(turnSeq, role)` 累加。
 * `final: true` 的意思是「这个角色在这一轮说完了」，只留那一帧会只剩最后一个词。
 */

import type { RealtimeTranscript } from "@kanyun-ai-infra/agenthub/realtime";

export interface FreetalkTurn {
  turnSeq: number;
  /** 平台把这一轮存下来之后才有。 */
  turnId?: string;
  user: string;
  assistant: string;
  /** 两个角色都 `final` 过了。 */
  done: boolean;
}

/** 折成对话稿：`turnSeq` 不是正整数的帧丢掉，轮的顺序按第一次出现排。 */
export function foldRealtimeTranscript(events: readonly RealtimeTranscript[]): FreetalkTurn[] {
  const bySeq = new Map<number, FreetalkTurn & { userDone: boolean; assistantDone: boolean }>();
  for (const event of events) {
    const seq = event?.turnSeq;
    if (!Number.isSafeInteger(seq) || (seq as number) <= 0) continue;
    if (event.role !== "user" && event.role !== "assistant") continue;
    let turn = bySeq.get(seq);
    if (!turn) {
      turn = { turnSeq: seq, user: "", assistant: "", done: false, userDone: false, assistantDone: false };
      bySeq.set(seq, turn);
    }
    if (typeof event.text === "string" && event.text) {
      if (event.role === "user") turn.user += event.text;
      else turn.assistant += event.text;
    }
    if (event.final) {
      if (event.role === "user") turn.userDone = true;
      else turn.assistantDone = true;
    }
    if (event.turnId && !turn.turnId) turn.turnId = event.turnId;
    turn.done = turn.userDone && turn.assistantDone;
  }
  return [...bySeq.values()].map(({ userDone, assistantDone, ...turn }) => turn);
}

export interface FreetalkLabels {
  user: string;
  agent: string;
}

export interface FreetalkLine {
  role: "user" | "assistant";
  text: string;
  turnSeq: number;
  turnId?: string;
}

/** 一句一行，按时间排；没说话的那一侧不出行。 */
export function freetalkLines(turns: readonly FreetalkTurn[]): FreetalkLine[] {
  const lines: FreetalkLine[] = [];
  for (const turn of turns) {
    if (turn.user) lines.push({ role: "user", text: turn.user, turnSeq: turn.turnSeq });
    if (turn.assistant) {
      lines.push({ role: "assistant", text: turn.assistant, turnSeq: turn.turnSeq, ...(turn.turnId ? { turnId: turn.turnId } : {}) });
    }
  }
  return lines;
}

/** 挂断时学员没说完的那一句，在点评请求里行末加这个标记。 */
export const UNFINISHED_MARK = "（未说完）";

export function freetalkTranscriptLines(
  turns: readonly FreetalkTurn[],
  labels: FreetalkLabels,
  unfinishedTurn: number | null = null,
): string[] {
  return freetalkLines(turns).map((line) =>
    line.role === "user" && line.turnSeq === unfinishedTurn
      ? `${labels.user}：${line.text.trimEnd()}${UNFINISHED_MARK}`
      : `${line.role === "user" ? labels.user : labels.agent}：${line.text}`,
  );
}

/**
 * 挂断后发给 agent 的 `【点评】` 请求，转写附在消息里。
 * 改这段文字要同步改 `agenthub/agents/edu-english-freetalk/evals/smoke.yaml` 里的同一条。
 */
export function buildReviewRequest(
  turns: readonly FreetalkTurn[],
  labels: FreetalkLabels,
  unfinishedTurn: number | null = null,
): string {
  const body = freetalkTranscriptLines(turns, labels, unfinishedTurn).join("\n");
  return [
    "【点评】下面是刚才这次英语自由对话的转写。请用中文写两三句点评（这是给学习者看的，不在通话里说出来）。",
    "不要接着聊、不要问问题、不打分、不逐句纠错；先说他做得好的一个具体地方，再给一个可以改进的点并附一个更自然的说法。",
    "",
    body,
  ].join("\n");
}

/**
 * 实时通话结束时（挂断或回落）学员最后那句没说完的那一轮的 turnSeq，否则 null。
 * 挂断后 SDK 不再送转写，所以点评只能带已经到手的半句。
 */
export function unfinishedUserTurn(events: readonly RealtimeTranscript[]): number | null {
  const valid = events.filter(
    (event) =>
      Number.isSafeInteger(event?.turnSeq) &&
      (event.turnSeq as number) > 0 &&
      (event.role === "user" || event.role === "assistant"),
  );
  if (valid.length === 0) return null;
  const last = Math.max(...valid.map((event) => event.turnSeq));
  let said = false;
  let final = false;
  for (const event of valid) {
    if (event.turnSeq !== last) continue;
    if (event.role === "assistant") return null;
    if (typeof event.text === "string" && event.text) said = true;
    if (event.final) final = true;
  }
  return said && !final ? last : null;
}

export function hasAnythingToReview(turns: readonly FreetalkTurn[]): boolean {
  return turns.some((turn) => turn.user !== "" || turn.assistant !== "");
}
