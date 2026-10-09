/**
 * 页面等一轮回合的终态：先 `POST /api/agenthub/turn`，没到终态（`pending`）就问
 * `/api/agenthub/turn-result`，直到终态或到上限。语音回合只走后一半（`voice-turn` 派发后直接轮询）。
 *
 * 为什么不一次等到底：站点前面那一跳反向代理 60 s 读超时，超过 60 s 的回合会把那一次
 * 请求砍成 504，页面丢掉这一轮的终态。现在每一次请求服务端最多挂 `TURN_REQUEST_MAX_MS`
 * （`lib/agenthub/turn-wait.ts`，N = 20 s）。
 *
 * 一轮的请求数：1 次 POST + k 次 turn-result。每次请求在服务端约等 W ≈ 14 s（N 减去两段余量，见
 * `turn-wait.ts`），回合 t 秒到终态时 k ≈ ⌈(t − W) / W⌉（t ≤ W 时 k = 0）；例：70 s 的回合 = 1 + 4 次
 * （`scripts/turn-short-poll/check.mjs` 的 ceiling-70s 读数）。上限两条，先到先停：从派发算满
 * `TURN_RESULT_MAX_WAIT_MS`（总时长 ≤ 它 + N），或 turn-result 读满 `TURN_RESULT_MAX_READS` 次（防一直
 * 秒回 pending 的空转）。turn-result 只读、幂等：一次读遇到网络错误或 5xx，隔 `READ_RETRY_DELAY_MS` 重读一次
 * 再判失败（一轮要读好几次，抖一下不该丢掉整轮）。重读也算一次读。POST 不重试（会重复派发）。
 *
 * 纯逻辑：请求和时钟由调用方注入（页面接 `fetch` + `Date.now`，`scripts/turn-short-poll/check.mjs`
 * 接路由处理函数 + 假时钟）。
 */

import type { Message, TraceItem } from "@/components/agent/useAgentConversation";
import { describeTool } from "./tool-labels";
import type { TurnCard } from "./turn-parts";

/** 从派发算的总时长上限。语音回合原来是 8 × 25 s，这里保持 200 s。 */
export const TURN_RESULT_MAX_WAIT_MS = 200_000;
/** turn-result 最多读几次：200 s / 每次约 14–17 s ≈ 15（正常是墙钟先到，它只防空转）。 */
export const TURN_RESULT_MAX_READS = 15;
/** 一次读失败（网络错误 / 5xx）后隔多久重读。 */
export const READ_RETRY_DELAY_MS = 1_000;

/**
 * 站点的归属校验没过（404，见 `lib/agenthub/session-binding.ts`）：这个浏览器手里已经没有这个会话的
 * cookie——清过 cookie、绑定过期、站点换了密钥，或者页面是部署前打开的。
 */
export const SESSION_LOST = "session_not_found";

/** `/turn` 与 `/turn-result` 的响应（两者形状相同；出错时只有 `error` / `detail`）。 */
export interface TurnResult {
  status?: string;
  turnId?: string;
  transcript?: string;
  replyText?: string;
  cards?: TurnCard[];
  toolCalls?: { id: string; name: string; shortName: string; failed: boolean }[];
  error?: string;
  detail?: string;
}

/** 一次请求的回答：HTTP 状态 + 解析好的 JSON。 */
export interface JsonReply {
  httpStatus: number;
  body: TurnResult;
}

const isOk = (httpStatus: number) => httpStatus >= 200 && httpStatus < 300;

export interface PollLimits {
  /** 总时长从哪一刻算（文字回合 = 发 POST 之前）。默认 = 开始轮询时。 */
  startedAt?: number;
  maxWaitMs?: number;
  maxReads?: number;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 问 turn-result 直到不是 `pending`。非 2xx 收成 `failed`（`error` = 平台/站点的错误码）；到上限收成
 * `failed` + `SESSION_TURN_WAIT_TIMEOUT`。网络错误或 5xx 先重读一次；重读还是网络错误就照原样抛给调用方。
 */
export async function pollTurnResult(
  deps: { read: () => Promise<JsonReply>; now: () => number; sleep?: (ms: number) => Promise<void> },
  { startedAt = deps.now(), maxWaitMs = TURN_RESULT_MAX_WAIT_MS, maxReads = TURN_RESULT_MAX_READS }: PollLimits = {},
): Promise<{ result: TurnResult; reads: number }> {
  const sleep = deps.sleep ?? sleepMs;
  let reads = 0;
  /** 读一次；网络错误或 5xx 隔一下重读一次（只重读一次）。 */
  const readWithRetry = async (): Promise<JsonReply> => {
    let first: JsonReply;
    try {
      first = await deps.read();
    } catch {
      reads += 1;
      await sleep(READ_RETRY_DELAY_MS);
      reads += 1;
      return deps.read();
    }
    reads += 1;
    if (first.httpStatus < 500) return first;
    await sleep(READ_RETRY_DELAY_MS);
    reads += 1;
    return deps.read();
  };
  while (reads < maxReads && deps.now() - startedAt < maxWaitMs) {
    const { httpStatus, body } = await readWithRetry();
    if (!isOk(httpStatus)) {
      return { result: { ...body, status: "failed", error: body.error ?? `HTTP_${httpStatus}` }, reads };
    }
    if (body.status !== "pending") return { result: body, reads };
  }
  return { result: { status: "failed", error: "SESSION_TURN_WAIT_TIMEOUT" }, reads };
}

export type TextTurnStep =
  /** 归属没过：这句话没发出去，调用方换一个会话。 */
  | { kind: "session_lost" }
  /** 会话闲置被回收、正在恢复：回合被拒（不是排队），调用方决定恢复后要不要重发。 */
  | { kind: "reviving" }
  /**
   * 回合有了结论：完成、失败、等到上限、或请求出错。`posted` = POST 回了 2xx（归属验过）；
   * `requests` = 这一轮一共发了几次请求（POST + turn-result）。
   */
  | { kind: "settled"; posted: boolean; turnId?: string; result: TurnResult; requests: number };

/** 一轮文字回合：POST 派发（最多挂 N 秒），没到终态就接着轮询 turn-result。 */
export async function runTextTurn(
  deps: { post: () => Promise<JsonReply>; read: (turnId: string) => Promise<JsonReply>; now: () => number },
  limits: Omit<PollLimits, "startedAt"> = {},
): Promise<TextTurnStep> {
  const startedAt = deps.now();
  const { httpStatus, body } = await deps.post();
  if (httpStatus === 404 && body.error === SESSION_LOST) return { kind: "session_lost" };
  if (body.status === "revival_in_progress") return { kind: "reviving" };
  if (!isOk(httpStatus)) {
    return { kind: "settled", posted: false, result: { ...body, error: body.error ?? `HTTP_${httpStatus}` }, requests: 1 };
  }
  const turnId = body.turnId;
  if (body.status !== "pending" || !turnId) return { kind: "settled", posted: true, turnId, result: body, requests: 1 };
  const polled = await pollTurnResult({ read: () => deps.read(turnId), now: deps.now }, { ...limits, startedAt });
  return { kind: "settled", posted: true, turnId, result: polled.result, requests: 1 + polled.reads };
}

type AgentMessage = Extract<Message, { role: "agent" }>;

/**
 * 终态替换掉流式画的内容（流只管看，终态是权威）：正文、卡片、工具轨迹换成终态的，流式的中间态清掉。
 * 终态不是 `completed`（失败、中断、等到上限、请求出错）就标成失败。
 */
export function settledAgentMessage(m: AgentMessage, result: TurnResult, turnId?: string): AgentMessage {
  const trace: TraceItem[] = (result.toolCalls ?? []).map((t) => {
    const { label, kind } = describeTool(t.name);
    return { id: t.id, label, kind, done: true };
  });
  return {
    ...m,
    text: result.replyText ?? m.text,
    cards: result.cards ?? m.cards,
    trace: trace.length > 0 ? trace : m.trace,
    thinking: "",
    drafts: undefined,
    stage: undefined,
    draft: undefined,
    streaming: false,
    failed: result.status !== "completed",
    ...(turnId ? { turnId } : {}),
  };
}
