import { PilotPlatformApiError } from "@kanyun-ai-infra/agenthub";
import { getAgentHubClient, isAgentHubConfigured } from "@/lib/agenthub/client";
import { renderTurn } from "@/lib/agenthub/turn-parts";
import { errorResponse, httpStatusOf } from "@/lib/backend/errors";

/**
 * 一轮已派发的回合的结果：等它到终态，交回正文、卡片和工具轨迹（形状同 `/api/agenthub/turn`）。
 *
 * 给语音回合用：`/api/agenthub/voice-turn` 派发后只交回转写就返回了，agent 的文字点评从
 * 这里取。逐字内容走 SSE（`/api/agenthub/stream`），这里是终态的权威——同
 * `useAgentConversation` 里「流只管看、POST 管终态」的分工。
 *
 * 每次最多等 `WAIT_MS`，没到终态就回 `{ status: "pending" }`，页面再问一次：一次长挂的
 * 请求会被中间某一跳的空闲超时掐断（外层网关 60 s 掐空闲连接），短等 + 重问不怕这个。
 * `transcript` 一并带上：voice-turn 那一跳没读到转写时（回合行还不可见），页面从这里补拿。
 *
 * 不挂跨站挡板：只读、不花钱，和 `/api/agenthub/stream` 一样。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 单次等待上限，留在网关 60 s 空闲超时以内。 */
const WAIT_MS = 25_000;

function fail(status: number, code: string, detail?: string): Response {
  return Response.json({ error: code, ...(detail ? { detail } : {}) }, { status });
}

export async function GET(req: Request) {
  if (!isAgentHubConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 501 });
  }
  const url = new URL(req.url);
  const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
  const turnId = (url.searchParams.get("turnId") ?? "").trim();
  if (!sessionId || !turnId) {
    return fail(400, "bad_request", "sessionId 和 turnId 都是必填的。");
  }

  const { client } = getAgentHubClient();
  try {
    const { turn } = await client.sessions.waitForTurn(sessionId, turnId, {
      timeoutMs: WAIT_MS,
      signal: req.signal,
    });
    const rendered = renderTurn(turn.assistant?.parts);
    return Response.json({
      status: turn.status,
      turnId,
      transcript: turn.user?.text ?? "",
      replyText: rendered.replyText,
      cards: rendered.cards,
      toolCalls: rendered.toolCalls,
      reasoningCount: rendered.reasoning.length,
    });
  } catch (err) {
    if (err instanceof PilotPlatformApiError) {
      // 没等到终态不是错：回 pending，页面再问。SDK 抛这个错时 status 是 0（客户端侧），
      // 原样塞进 Response 会炸成裸 500。
      if (err.code === "SESSION_TURN_WAIT_TIMEOUT") {
        return Response.json({ status: "pending", turnId });
      }
      return fail(httpStatusOf(err), err.code);
    }
    return errorResponse(err);
  }
}
