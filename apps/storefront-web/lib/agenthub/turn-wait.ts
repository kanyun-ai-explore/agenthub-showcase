import { PilotPlatformApiError, type PilotPlatformClient } from "@kanyun-ai-infra/agenthub";
import { renderTurn } from "./turn-parts";

/**
 * 站点等回合终态的那一次请求最长挂多久（N）。`/api/agenthub/turn` 和 `/api/agenthub/turn-result` 共用。
 *
 * 站点前面那一跳反向代理的读超时是 60 s：一次请求 60 s 内没回响应头就被它砍成 504。
 * 电商首轮常态 54 s、见过 78.6 s，一次等到底必然撞线。所以每次最多等 N，没到终态就回
 * `{ status: "pending", turnId }`，页面接着问 `turn-result`（`lib/agenthub/turn-result-poll.ts`）。
 */
export const TURN_REQUEST_MAX_MS = 20_000;

/** SDK `waitForTurn` 读回合的间隔（显式传，下面的扣减按它算）。 */
const POLL_INTERVAL_MS = 1_000;

/**
 * SDK 到点后还会多走的时间，从 N 里先扣掉：它读完回合才看到没到点，所以最坏是到点前一刻又睡一个
 * 间隔、再读一次；读到终态时还要再读一次终态事件。平台的读按每次 ≤ 1 s 留。
 */
const SDK_OVERRUN_MS = POLL_INTERVAL_MS + 2 * 1_000;

/**
 * 请求进到处理函数之前的时间：这里量不到（路由冷加载、排队；本机 dev 首次编译一个路由实测 2.6–3.9 s，
 * 超出 3 s 的那点由上面 SDK 余量里没用到的部分兜住——平台的读通常远小于 1 s），也从 N 里留出来。
 */
const OUTSIDE_HANDLER_MS = 3_000;

/** 处理函数自己最多花多久（从进来到回响应）：N 减去处理函数外面的那段。 */
export const TURN_HANDLER_MAX_MS = TURN_REQUEST_MAX_MS - OUTSIDE_HANDLER_MS;

type SettledTurn = Awaited<ReturnType<PilotPlatformClient["sessions"]["waitForTurn"]>>["turn"];

/**
 * 在这次请求剩下的时间里等回合终态。`startedAt` 是请求进来的时刻（`/turn` 先派发再等，派发花的
 * 时间也算在 N 里）。到点没终态回 `null`，不是错。
 */
export async function waitForTurnWithin(
  client: PilotPlatformClient,
  sessionId: string,
  turnId: string,
  { startedAt, signal }: { startedAt: number; signal?: AbortSignal },
): Promise<SettledTurn | null> {
  const budget = Math.max(0, startedAt + TURN_HANDLER_MAX_MS - SDK_OVERRUN_MS - Date.now());
  try {
    const { turn } = await client.sessions.waitForTurn(sessionId, turnId, {
      timeoutMs: budget,
      intervalMs: POLL_INTERVAL_MS,
      signal,
    });
    return turn;
  } catch (err) {
    // SDK 抛这个错时 status 是 0（客户端侧），原样塞进 Response 会炸成裸 500。
    if (err instanceof PilotPlatformApiError && err.code === "SESSION_TURN_WAIT_TIMEOUT") return null;
    throw err;
  }
}

/** 到了终态的回合交给页面的样子：正文、卡片、工具轨迹。两个路由回的形状一样。 */
export function settledTurnBody(turn: SettledTurn, turnId: string) {
  const rendered = renderTurn(turn.assistant?.parts);
  return {
    status: turn.status,
    turnId,
    transcript: turn.user?.text ?? "",
    replyText: rendered.replyText,
    cards: rendered.cards,
    toolCalls: rendered.toolCalls,
    reasoningCount: rendered.reasoning.length,
  };
}
